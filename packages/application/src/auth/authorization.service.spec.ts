import { describe, expect, it } from 'vitest';
import {
  asGroupId,
  asTelegramId,
  asUserId,
  type GroupMembership,
  type GroupRole,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { ConfigureGroup } from '../groups/configure-group.js';
import { ChangeChargeStatus } from '../payments/change-charge-status.js';
import type { PaymentRepository } from '../payments/ports.js';
import {
  AuthorizationDeniedError,
  AuthorizationService,
  type AuthorizationRepository,
} from './authorization.service.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const administrator = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424612');
const organizer = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424613');
const member = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424614');
const administratorTelegramId = asTelegramId('42');
const memberTelegramId = asTelegramId('43');

describe('AuthorizationService shared role hierarchy', () => {
  it('authorizes an internal administrator for an organizer application flow', async () => {
    const authorization = createAuthorization([
      membership(administrator, administratorTelegramId, 'ADMIN'),
    ]);

    await expect(
      authorization.requireRole(groupId, administrator, 'ORGANIZER'),
    ).resolves.toBeUndefined();
  });

  it('denies an internal member from the same organizer application flow', async () => {
    const authorization = createAuthorization([
      membership(member, memberTelegramId, 'MEMBER'),
    ]);

    await expect(
      authorization.requireRole(groupId, member, 'ORGANIZER'),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('resolves Telegram identity and applies the same administrator threshold', async () => {
    const authorization = createAuthorization([
      membership(administrator, administratorTelegramId, 'ADMIN'),
    ]);

    await expect(
      authorization.requireTelegramRole(
        groupId,
        administratorTelegramId,
        'ADMIN',
      ),
    ).resolves.toBe(administrator);
  });

  it('denies a Telegram organizer at the administrator threshold', async () => {
    const authorization = createAuthorization([
      membership(organizer, administratorTelegramId, 'ORGANIZER'),
    ]);

    await expect(
      authorization.requireTelegramRole(
        groupId,
        administratorTelegramId,
        'ADMIN',
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('denies a Telegram-triggered administrator flow through the shared hierarchy', async () => {
    const authorization = createAuthorization([
      membership(member, memberTelegramId, 'MEMBER'),
    ]);
    let configured = false;
    const useCase = new ConfigureGroup(authorization, {
      configure: async () => {
        configured = true;
      },
    });

    await expect(
      useCase.execute({
        groupId,
        actorTelegramId: memberTelegramId,
        timeZone: 'Europe/Astrakhan',
        memberPriorityEnabled: false,
        tentativePromptMinutesBefore: 60,
        tentativeResponseMinutes: 30,
        reminderMinutesBefore: 120,
        currency: 'RUB',
        roundingMode: 'EXACT',
        pinGameMessages: false,
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(configured).toBe(false);
  });

  it('drives an organizer-gated application use case through the shared service', async () => {
    const authorization = createAuthorization([
      membership(organizer, administratorTelegramId, 'ORGANIZER'),
    ]);
    const useCase = new ChangeChargeStatus(authorization, {
      ...unusedPayments,
      changeChargeStatus: async (input) => ({
        id: input.chargeId,
        settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        participantRef: 'registration:player',
        displayName: 'Player',
        addedManually: false,
        privateReminderAvailable: true,
        amountMinor: 10_000n,
        status: input.status,
        createdAt: new Date('2026-08-31T00:00:00.000Z'),
      }),
    });

    await expect(
      useCase.execute({
        groupId,
        chargeId: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
        actorUserId: organizer,
        status: 'PAID',
      }),
    ).resolves.toMatchObject({ status: 'PAID' });
  });
});

const membership = (
  userId: UserId,
  telegramUserId: TelegramId,
  role: GroupRole,
): GroupMembership => ({
  groupId,
  userId,
  telegramUserId,
  role,
  membershipStatus: 'ACTIVE',
  checkedAt: new Date('2026-08-31T00:00:00.000Z'),
});

const createAuthorization = (
  memberships: readonly GroupMembership[],
): AuthorizationService => {
  const repository: AuthorizationRepository & {
    findMembershipByTelegramUserId(
      requestedGroupId: typeof groupId,
      telegramUserId: TelegramId,
    ): Promise<GroupMembership | null>;
  } = {
    findMembership: async (requestedGroupId, userId) =>
      memberships.find(
        (candidate) =>
          candidate.groupId === requestedGroupId && candidate.userId === userId,
      ) ?? null,
    findMembershipByTelegramUserId: async (requestedGroupId, telegramUserId) =>
      memberships.find(
        (candidate) =>
          candidate.groupId === requestedGroupId &&
          candidate.telegramUserId === telegramUserId,
      ) ?? null,
  };
  return new AuthorizationService(repository);
};

const unusedPayments: PaymentRepository = {
  findFinalizedAttendance: async () => null,
  withLockedFinalizedAttendance: async () => {
    throw new Error('unused');
  },
  finalizeDraft: async () => {
    throw new Error('unused');
  },
  changeChargeStatus: async () => {
    throw new Error('unused');
  },
  enqueueReminders: async () => {
    throw new Error('unused');
  },
};
