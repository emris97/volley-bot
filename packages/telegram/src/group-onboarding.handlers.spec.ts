import type { TelegramGateway } from '@volley/application';
import { asGroupId, asTelegramId, type Group } from '@volley/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupOnboardingHandlers } from './group-onboarding.handlers.js';
import { OnboardingInputError } from './group-onboarding.model.js';
import { SignedStartToken } from './signed-start-token.js';

const groupId = asGroupId('00000000-0000-4000-8000-000000000001');
const groupChatId = asTelegramId('-1001000000001');
const administratorId = asTelegramId('42');
const privateChatId = asTelegramId('42');

describe('GroupOnboardingHandlers', () => {
  let snapshot: Snapshot;
  let sent: Message[];
  let edited: Message[];
  let configured: Record<string, unknown>[];
  let adminStatus: 'administrator' | 'member';
  let onboardingRuns: number;
  let enabledChanges: boolean[];
  let forceProgressConflict: boolean;
  let forceSaveConflict: boolean;
  let handlers: GroupOnboardingHandlers;
  let signer: SignedStartToken;

  beforeEach(() => {
    snapshot = pendingSnapshot();
    sent = [];
    edited = [];
    configured = [];
    adminStatus = 'administrator';
    onboardingRuns = 0;
    enabledChanges = [];
    forceProgressConflict = false;
    forceSaveConflict = false;
    signer = new SignedStartToken(
      'a-start-token-secret-with-at-least-32-bytes',
    );
    const telegram: TelegramGateway = {
      getChatMember: vi.fn(async () => ({ status: adminStatus })),
      sendMessage: vi.fn(async (chatId, message, options) => {
        sent.push({ chatId, message, options });
        return { messageId: 700n };
      }),
      editMessage: vi.fn(async (chatId, messageId, message, options) => {
        edited.push({ chatId, messageId, message, options });
      }),
    };
    const groups = {
      findByTelegramChatId: vi.fn(async () => ({
        ...group(),
        onboardingState: snapshot.onboardingState,
      })),
      setEnabled: vi.fn(async (_requestedGroupId, enabled) => {
        enabledChanges.push(enabled);
        return group();
      }),
      getOnboardingSnapshot: vi.fn(async () => structuredClone(snapshot)),
      saveWizardProgress: vi.fn(async (_requestedGroupId, progress) => {
        snapshot.progress = structuredClone(progress);
      }),
      compareAndSetWizardProgress: vi.fn(
        async (_requestedGroupId, expectedProgress, progress) => {
          if (
            forceProgressConflict ||
            JSON.stringify(snapshot.progress) !==
              JSON.stringify(expectedProgress)
          ) {
            snapshot.progress = {};
            return false;
          }
          snapshot.progress = structuredClone(progress);
          return true;
        },
      ),
    };
    handlers = new GroupOnboardingHandlers(
      {
        execute: vi.fn(async () => {
          onboardingRuns += 1;
          return {
            kind: 'ONBOARDING_STARTED' as const,
            groupId,
            privateChatLink: 'https://t.me/volley_test_bot?start=fresh',
          };
        }),
      } as never,
      {
        execute: vi.fn(async (command: Record<string, unknown>) => {
          if (forceSaveConflict) {
            snapshot.progress = {};
            return false;
          }
          configured.push(command);
          snapshot = {
            ...snapshot,
            onboardingState: 'CONFIGURED',
            progress: {},
            settings: {
              timeZone: String(command.timeZone),
              memberPriorityEnabled: Boolean(command.memberPriorityEnabled),
              tentativePromptMinutesBefore: Number(
                command.tentativePromptMinutesBefore,
              ),
              tentativeResponseMinutes: Number(
                command.tentativeResponseMinutes,
              ),
              reminderMinutesBefore: Number(command.reminderMinutesBefore),
              currency: 'RUB',
              roundingMode:
                command.roundingMode as Snapshot['settings']['roundingMode'],
              pinGameMessages: Boolean(command.pinGameMessages),
            },
          };
          return true;
        }),
      } as never,
      {
        requireTelegramRole: vi.fn(async () => asGroupId(String(groupId))),
      } as never,
      groups,
      signer,
      telegram,
    );
  });

  it('resumes the first unanswered step from a valid private start link', async () => {
    snapshot.progress = { tz: 'Europe/Astrakhan', mp: true };

    await expect(
      handlers.handleStart({
        telegramUserId: administratorId,
        privateChatId,
        token: configurationToken(administratorId),
      }),
    ).resolves.toBe(true);

    expect(sent.at(-1)?.message).toContain('Шаг 3 из 7');
  });

  it('edits one message through all answers and configures only after save', async () => {
    for (const [code, value] of [
      ['tz', 'Europe/Astrakhan'],
      ['mp', '1'],
      ['tp', '1440'],
      ['tr', '60'],
      ['rm', '120'],
      ['ro', 'UP_10'],
      ['pin', '1'],
    ] as const) {
      await handlers.handleCallback({
        telegramUserId: administratorId,
        privateChatId,
        messageId: 500n,
        data: `cfg:${groupId}:${code}:${value}`,
      });
    }
    expect(configured).toHaveLength(0);
    expect(edited.at(-1)?.message).toContain('Проверьте настройки');

    const result = await handlers.handleCallback({
      telegramUserId: administratorId,
      privateChatId,
      messageId: 500n,
      data: `cfg:${groupId}:save:1`,
    });

    expect(result.notice).toBe('Настройки сохранены');
    expect(configured).toHaveLength(1);
    expect(configured[0]).toMatchObject({
      groupId,
      actorTelegramId: administratorId,
      timeZone: 'Europe/Astrakhan',
      memberPriorityEnabled: true,
      pinGameMessages: true,
    });
    expect(edited.at(-1)?.message).toContain('Группа уже настроена');
  });

  it('renders authoritative progress for stale callbacks without mutation', async () => {
    snapshot.progress = { tz: 'Europe/Astrakhan' };

    const result = await handlers.handleCallback({
      telegramUserId: administratorId,
      privateChatId,
      messageId: 500n,
      data: `cfg:${groupId}:tz:Europe/Astrakhan`,
    });

    expect(result.notice).toBe('Показываю текущий шаг');
    expect(snapshot.progress).toEqual({ tz: 'Europe/Astrakhan' });
    expect(edited.at(-1)?.message).toContain('Шаг 2 из 7');
  });

  it('does not overwrite a concurrent progress transition', async () => {
    forceProgressConflict = true;

    const result = await handlers.handleCallback({
      telegramUserId: administratorId,
      privateChatId,
      messageId: 500n,
      data: `cfg:${groupId}:tz:Europe/Astrakhan`,
    });

    expect(result.notice).toBe('Показываю текущий шаг');
    expect(snapshot.progress).toEqual({});
    expect(edited.at(-1)?.message).toContain('Шаг 1 из 7');
  });

  it('renders the winning transition when save loses a concurrent reset', async () => {
    snapshot.progress = completeProgress();
    forceSaveConflict = true;

    const result = await handlers.handleCallback({
      telegramUserId: administratorId,
      privateChatId,
      messageId: 500n,
      data: `cfg:${groupId}:save:1`,
    });

    expect(result.notice).toBe('Показываю текущий шаг');
    expect(configured).toHaveLength(0);
    expect(edited.at(-1)?.message).toContain('Шаг 1 из 7');
  });

  it('resets progress and sends a replacement when no message is editable', async () => {
    snapshot.progress = { tz: 'Europe/Astrakhan', mp: true };

    await handlers.handleCallback({
      telegramUserId: administratorId,
      privateChatId,
      data: `cfg:${groupId}:reset:1`,
    });

    expect(snapshot.progress).toEqual({});
    expect(sent.at(-1)?.message).toContain('Шаг 1 из 7');
  });

  it('rejects callbacks outside the administrator private chat', async () => {
    await expect(
      handlers.handleCallback({
        telegramUserId: administratorId,
        privateChatId: asTelegramId('99'),
        messageId: 500n,
        data: `cfg:${groupId}:tz:Europe/Astrakhan`,
      }),
    ).rejects.toEqual(new OnboardingInputError('FOREIGN_LINK'));
  });

  it('rejects a cached administrator who no longer has Telegram admin rights', async () => {
    adminStatus = 'member';

    await expect(
      handlers.handleStart({
        telegramUserId: administratorId,
        privateChatId,
        token: configurationToken(administratorId),
      }),
    ).rejects.toEqual(new OnboardingInputError('ADMIN_REQUIRED'));
  });

  it('restarts unfinished onboarding but only re-enables a configured group', async () => {
    await handlers.handleMyChatMember({
      telegramChatId: groupChatId,
      actorTelegramId: administratorId,
      title: 'Volley',
      newStatus: 'member',
    });
    expect(onboardingRuns).toBe(1);
    expect(sent.at(-1)?.message).toContain('start=fresh');

    snapshot.onboardingState = 'CONFIGURED';
    await handlers.handleMyChatMember({
      telegramChatId: groupChatId,
      actorTelegramId: administratorId,
      title: 'Volley',
      newStatus: 'member',
    });
    expect(onboardingRuns).toBe(1);
    expect(enabledChanges).toEqual([true]);
  });

  it('does not reactivate a configured group for a non-admin actor', async () => {
    snapshot.onboardingState = 'CONFIGURED';
    adminStatus = 'member';

    await expect(
      handlers.handleMyChatMember({
        telegramChatId: groupChatId,
        actorTelegramId: administratorId,
        title: 'Volley',
        newStatus: 'member',
      }),
    ).rejects.toEqual(new OnboardingInputError('ADMIN_REQUIRED'));

    expect(enabledChanges).toEqual([]);
  });

  const configurationToken = (owner: typeof administratorId): string =>
    signer.sign({
      purpose: 'configure-group',
      groupId,
      administratorTelegramId: owner,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
});

interface Snapshot {
  telegramChatId: typeof groupChatId;
  onboardingState: 'PENDING' | 'CONFIGURING' | 'CONFIGURED';
  progress: Record<string, unknown>;
  settings: {
    timeZone: string;
    memberPriorityEnabled: boolean;
    tentativePromptMinutesBefore: number;
    tentativeResponseMinutes: number;
    reminderMinutesBefore: number;
    currency: 'RUB';
    roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
    pinGameMessages: boolean;
  };
}

interface Message {
  chatId: string;
  messageId?: bigint;
  message: string;
  options?: unknown;
}

const pendingSnapshot = (): Snapshot => ({
  telegramChatId: groupChatId,
  onboardingState: 'CONFIGURING',
  progress: {},
  settings: {
    timeZone: 'UTC',
    memberPriorityEnabled: false,
    tentativePromptMinutesBefore: 1440,
    tentativeResponseMinutes: 60,
    reminderMinutesBefore: 120,
    currency: 'RUB',
    roundingMode: 'EXACT',
    pinGameMessages: true,
  },
});

const completeProgress = (): Record<string, unknown> => ({
  tz: 'Europe/Astrakhan',
  mp: true,
  tp: 1440,
  tr: 60,
  rm: 120,
  ro: 'EXACT',
  pin: true,
});

const group = (): Group => ({
  id: groupId,
  telegramChatId: groupChatId,
  title: 'Volley',
  timeZone: 'UTC',
  enabled: true,
  onboardingState: 'CONFIGURING',
  createdAt: new Date('2026-09-05T00:00:00.000Z'),
  updatedAt: new Date('2026-09-05T00:00:00.000Z'),
});
