import { asGroupId, asTelegramId, asUserId, type Group } from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import { ChangeGroupRole } from './change-group-role.js';

const group: Group = {
  id: asGroupId('00000000-0000-4000-8000-000000000001'),
  telegramChatId: asTelegramId('-1001000000001'),
  title: 'Volleyball',
  timeZone: 'Europe/Moscow',
  enabled: true,
  onboardingState: 'CONFIGURED',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ChangeGroupRole', () => {
  it('lets an admin grant organizer to a current Telegram member', async () => {
    const groups = {
      findById: vi.fn().mockResolvedValue(group),
      findMembership: vi.fn().mockResolvedValue({
        groupId: group.id,
        userId: asUserId('00000000-0000-4000-8000-000000000002'),
        telegramUserId: asTelegramId('1'),
        role: 'ADMIN',
        membershipStatus: 'ACTIVE',
        checkedAt: new Date(),
      }),
      upsertMembership: vi.fn().mockResolvedValue(undefined),
      recordRoleChange: vi.fn().mockResolvedValue(undefined),
    };
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'member' }),
      sendMessage: vi.fn(),
    };
    const useCase = new ChangeGroupRole(telegram, groups);

    await useCase.execute({
      groupId: group.id,
      actorTelegramId: asTelegramId('1'),
      targetTelegramId: asTelegramId('2'),
      role: 'ORGANIZER',
    });

    expect(groups.upsertMembership).toHaveBeenCalledWith(
      group.id,
      asTelegramId('2'),
      'ORGANIZER',
    );
    expect(groups.recordRoleChange).toHaveBeenCalledOnce();
  });

  it('does not let an organizer grant roles', async () => {
    const groups = {
      findById: vi.fn().mockResolvedValue(group),
      findMembership: vi.fn().mockResolvedValue({
        role: 'ORGANIZER',
        membershipStatus: 'ACTIVE',
      }),
      upsertMembership: vi.fn(),
      recordRoleChange: vi.fn(),
    };
    const useCase = new ChangeGroupRole(
      { getChatMember: vi.fn(), sendMessage: vi.fn() },
      groups,
    );

    await expect(
      useCase.execute({
        groupId: group.id,
        actorTelegramId: asTelegramId('1'),
        targetTelegramId: asTelegramId('2'),
        role: 'MEMBER',
      }),
    ).rejects.toThrow(/owner|admin/i);
  });
});
