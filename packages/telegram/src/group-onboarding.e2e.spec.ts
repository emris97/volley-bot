import { readdir, readFile } from 'node:fs/promises';
import {
  AuthorizationService,
  ConfigureGroup,
  OnboardGroup,
  type TelegramGateway,
} from '@volley/application';
import { asTelegramId } from '@volley/domain';
import { createDatabase, GroupRepository } from '@volley/persistence';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
} from './bot.factory.js';
import { GroupOnboardingHandlers } from './group-onboarding.handlers.js';
import { SignedStartToken } from './signed-start-token.js';
import { WebhookController } from './webhook.controller.js';

const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Volley',
  username: 'volley_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const groupChatId = asTelegramId('-1001000000001');
const administratorId = asTelegramId('42');
const secret = 'webhook-secret-1234567890';
const migrationsUrl = new URL('../../persistence/migrations/', import.meta.url);

describe('group onboarding webhook', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let groups: GroupRepository;
  let messages: Array<{
    chatId: string;
    message: string;
    keyboard?: readonly (readonly {
      text: string;
      callbackData: string;
    }[])[];
  }>;
  let controller: WebhookController;
  let updateId = 1;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'volley',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_USER: 'postgres',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    pool = new Pool({
      connectionString: `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/volley`,
    });
    for (const file of (await readdir(migrationsUrl)).sort()) {
      if (file.endsWith('.sql')) {
        await pool.query(await readFile(new URL(file, migrationsUrl), 'utf8'));
      }
    }
    groups = new GroupRepository(createDatabase(pool));
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  const createHarness = (): void => {
    messages = [];
    const telegram: TelegramGateway = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      sendMessage: vi.fn(async (chatId, message, options) => {
        messages.push({ chatId, message, keyboard: options?.keyboard });
        return { messageId: BigInt(messages.length) };
      }),
      editMessage: vi.fn(async (chatId, _messageId, message, options) => {
        messages.push({ chatId, message, keyboard: options?.keyboard });
      }),
    };
    const signer = new SignedStartToken(
      'a-start-token-secret-with-at-least-32-bytes',
    );
    const links = {
      create: (input: {
        groupId: Parameters<typeof groups.findById>[0];
        administratorTelegramId: typeof administratorId;
      }): string => {
        const token = signer.sign({
          purpose: 'configure-group',
          ...input,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        return `https://t.me/${botInfo.username}?start=${token}`;
      },
    };
    const authorization = new AuthorizationService({
      findMembership: (requestedGroupId, userId) =>
        groups.findMembershipByUserId(requestedGroupId, userId),
      findMembershipByTelegramUserId: (requestedGroupId, telegramUserId) =>
        groups.findMembership(requestedGroupId, telegramUserId),
    });
    const handlers = new GroupOnboardingHandlers(
      new OnboardGroup(telegram, groups, links),
      new ConfigureGroup(authorization, groups),
      authorization,
      groups,
      signer,
      telegram,
    );
    const bot = createTelegramBot(
      '123456:abcdefghijklmnopqrstuvwxyz',
      botInfo,
      handlers,
    );
    bot.api.config.use(async () => ({ ok: true, result: true }) as never);
    controller = new WebhookController(
      createLazyTelegramUpdateHandler(bot),
      secret,
    );
  };

  it('rejects an invalid webhook secret before dispatching the update', async () => {
    createHarness();

    await expect(
      controller.handle('wrong-secret', addedToGroupUpdate()),
    ).rejects.toThrow(/unauthorized/i);
    expect(await groups.findByTelegramChatId(groupChatId)).toBeNull();
  });

  it('persists, resumes, and completes the onboarding wizard', async () => {
    createHarness();
    await controller.handle(secret, addedToGroupUpdate());
    const started = await groups.findByTelegramChatId(groupChatId);
    expect(started).toMatchObject({ onboardingState: 'CONFIGURING' });

    const token = messages[0]?.message.split('?start=')[1];
    expect(token).toBeTruthy();
    await controller.handle(secret, startUpdate(token!));
    expect(messages.at(-1)?.message).toContain('Шаг 1 из 7');

    await click('Астрахань (UTC+4)');
    createHarness();
    await controller.handle(secret, startUpdate(token!));
    expect(messages.at(-1)?.message).toContain('Шаг 2 из 7');

    for (const button of [
      'Участники группы выше гостей',
      'За 24 часа',
      '1 час',
      'За 2 часа',
      'Точно до копеек',
      'Да',
    ]) {
      await click(button);
    }
    expect(messages.at(-1)?.message).toContain('Проверьте настройки');
    await click('✅ Сохранить настройки');

    expect(await groups.findByTelegramChatId(groupChatId)).toMatchObject({
      enabled: true,
      onboardingState: 'CONFIGURED',
      timeZone: 'Europe/Astrakhan',
    });
    expect(messages.at(-1)?.message).toContain('Группа уже настроена');

    async function click(text: string): Promise<void> {
      const button = messages
        .at(-1)
        ?.keyboard?.flat()
        .find((candidate) => candidate.text === text);
      if (button === undefined) throw new Error(`Button ${text} missing`);
      await controller.handle(secret, callbackUpdate(button.callbackData));
    }
  });

  it('disables and reactivates the same group record with bot membership', async () => {
    createHarness();
    const existing = await groups.upsertFromTelegram({
      telegramChatId: groupChatId,
      title: 'Volleyball',
    });
    await controller.handle(secret, membershipUpdate('left'));
    expect(await groups.findByTelegramChatId(groupChatId)).toMatchObject({
      id: existing.id,
      enabled: false,
    });

    await controller.handle(secret, membershipUpdate('member'));
    expect(await groups.findByTelegramChatId(groupChatId)).toMatchObject({
      id: existing.id,
      enabled: true,
      onboardingState: 'PENDING',
    });
  });

  const addedToGroupUpdate = (): Update => membershipUpdate('member');

  const membershipUpdate = (status: 'member' | 'left'): Update => ({
    update_id: updateId++,
    my_chat_member: {
      chat: {
        id: Number(groupChatId),
        type: 'supergroup',
        title: 'Volleyball',
      },
      from: { id: Number(administratorId), is_bot: false, first_name: 'Admin' },
      date: 1_788_134_400,
      old_chat_member: {
        user: botInfo,
        status: status === 'left' ? 'member' : 'left',
      },
      new_chat_member: { user: botInfo, status },
    },
  });

  const startUpdate = (token: string): Update => ({
    update_id: updateId++,
    message: {
      message_id: updateId,
      date: 1_788_134_400,
      chat: {
        id: Number(administratorId),
        type: 'private',
        first_name: 'Admin',
      },
      from: { id: Number(administratorId), is_bot: false, first_name: 'Admin' },
      text: `/start ${token}`,
      entities: [{ offset: 0, length: 6, type: 'bot_command' }],
    },
  });

  const callbackUpdate = (data: string): Update => ({
    update_id: updateId++,
    callback_query: {
      id: String(updateId),
      chat_instance: 'test',
      from: { id: Number(administratorId), is_bot: false, first_name: 'Admin' },
      data,
      message: {
        message_id: updateId,
        date: 1_788_134_400,
        chat: {
          id: Number(administratorId),
          type: 'private',
          first_name: 'Admin',
        },
        text: 'configuration',
      },
    },
  });
});
