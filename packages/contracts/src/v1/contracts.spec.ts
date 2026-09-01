import { describe, expect, it } from 'vitest';
import { ChangeGroupRoleRequestSchema, GroupResponseSchema } from './groups.js';
import {
  ChangeRegistrationRequestSchema,
  RegistrationResponseSchema,
} from './registrations.js';
import {
  ChangeChargeStatusRequestSchema,
  PaymentChargeResponseSchema,
} from './payments.js';

describe('v1 command and result contracts', () => {
  it.each(['ORGANIZER', 'MEMBER'] as const)(
    'accepts the existing %s Telegram role command shape',
    (role) => {
      expect(
        ChangeGroupRoleRequestSchema.safeParse({
          targetTelegramId: '42',
          role,
        }).success,
      ).toBe(true);
    },
  );

  it.each(['OWNER', 'ADMIN'] as const)(
    'rejects unsupported direct %s assignment',
    (role) => {
      expect(
        ChangeGroupRoleRequestSchema.safeParse({
          targetTelegramId: '42',
          role,
        }).success,
      ).toBe(false);
    },
  );

  it('rejects internal user identifiers in the public role command', () => {
    expect(
      ChangeGroupRoleRequestSchema.safeParse({
        userId: '018f6ba0-62d2-7bd1-8f13-12e0c8424613',
        role: 'ORGANIZER',
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      action: 'ADD_NAMED',
      guestDisplayName: 'Late player',
      idempotencyKey: 'mini-app:add:1',
      reason: 'Organizer correction',
    },
    {
      action: 'CANCEL',
      registrationId: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
      reason: 'Participant unavailable',
    },
  ])('accepts an existing administrator registration command %#', (command) => {
    expect(ChangeRegistrationRequestSchema.safeParse(command).success).toBe(
      true,
    );
  });

  it.each(['ROSTERED', 'WAITLISTED'])(
    'rejects direct derived registration state %s',
    (state) => {
      expect(ChangeRegistrationRequestSchema.safeParse({ state }).success).toBe(
        false,
      );
    },
  );

  it('parses the existing registration application result', () => {
    expect(
      RegistrationResponseSchema.safeParse({
        registrationId: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
        state: 'WAITLISTED',
        waitlistPosition: 2,
      }).success,
    ).toBe(true);
  });

  it('keeps payment status commands actor- and tenant-neutral in the body', () => {
    expect(
      ChangeChargeStatusRequestSchema.safeParse({ status: 'PAID' }).success,
    ).toBe(true);
    expect(
      ChangeChargeStatusRequestSchema.safeParse({
        groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
        actorUserId: '018f6ba0-62d2-7bd1-8f13-12e0c8424613',
        status: 'PAID',
      }).success,
    ).toBe(false);
  });

  it('parses the existing payment charge application result', () => {
    expect(
      PaymentChargeResponseSchema.safeParse({
        id: '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
        settlementId: '018f6ba0-62d2-7bd1-8f13-12e0c8424621',
        participantRef: 'registration:player',
        displayName: 'Player',
        addedManually: false,
        amountMinor: '10000',
        status: 'UNPAID',
        createdAt: '2026-08-31T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('parses a serialized existing group result without omitting identity or lifecycle fields', () => {
    expect(
      GroupResponseSchema.safeParse({
        id: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
        telegramChatId: '-1001000000001',
        title: 'Volleyball',
        timeZone: 'Europe/Astrakhan',
        enabled: true,
        onboardingState: 'CONFIGURED',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
