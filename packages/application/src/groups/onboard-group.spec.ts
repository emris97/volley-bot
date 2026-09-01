import {
  asGroupId,
  asTelegramId,
  type Group,
  type GroupRole,
} from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { OnboardGroup } from './onboard-group.js';

const group: Group = {
  id: asGroupId('00000000-0000-4000-8000-000000000001'),
  telegramChatId: asTelegramId('-1001000000001'),
  title: 'Volleyball',
  timeZone: 'UTC',
  enabled: true,
  onboardingState: 'PENDING',
  createdAt: new Date('2026-08-31T00:00:00Z'),
  updatedAt: new Date('2026-08-31T00:00:00Z'),
};

describe('OnboardGroup', () => {
  it('allows a verified administrator to begin onboarding', async () => {
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      sendMessage: vi.fn(),
    };
    const groups = {
      upsertFromTelegram: vi.fn().mockResolvedValue(group),
      upsertMembership: vi.fn().mockResolvedValue(undefined),
      beginOnboarding: vi.fn().mockResolvedValue(undefined),
    };
    const links = {
      create: vi.fn().mockReturnValue('https://t.me/bot?start=x'),
    };
    const useCase = new OnboardGroup(telegram, groups, links);

    const result = await useCase.execute({
      telegramChatId: group.telegramChatId,
      telegramUserId: asTelegramId('42'),
      title: group.title,
    });

    expect(result).toMatchObject({
      kind: 'ONBOARDING_STARTED',
      groupId: group.id,
      privateChatLink: 'https://t.me/bot?start=x',
    });
    expect(groups.upsertMembership).toHaveBeenCalledWith(
      group.id,
      asTelegramId('42'),
      'ADMIN' satisfies GroupRole,
    );
    expect(groups.beginOnboarding).toHaveBeenCalledWith(
      group.id,
      asTelegramId('42'),
    );
  });

  it('rejects a regular group member', async () => {
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
      sendMessage: vi.fn(),
    };
    const useCase = new OnboardGroup(
      telegram,
      {
        upsertFromTelegram: vi.fn(),
        upsertMembership: vi.fn(),
        beginOnboarding: vi.fn(),
      },
      { create: vi.fn() },
    );

    await expect(
      useCase.execute({
        telegramChatId: group.telegramChatId,
        telegramUserId: asTelegramId('42'),
        title: group.title,
      }),
    ).rejects.toThrow(/administrator/i);
  });
});
