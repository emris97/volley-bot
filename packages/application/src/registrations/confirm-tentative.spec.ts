import { describe, expect, it, vi } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
} from '@volley/domain';
import { ConfirmTentative } from './confirm-tentative.js';
import { ExpireTentative } from './expire-tentative.js';

const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611');
const gameId = asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610');
const registrationId = asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620');
const actorUserId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424630');

describe('ConfirmTentative', () => {
  it('uses confirmation time when placing a tentative participant', async () => {
    const confirmedAt = new Date('2026-09-01T12:00:00.000Z');
    const repository = {
      confirmTentative: vi.fn().mockImplementation(async (input) => ({
        registrationId,
        state: 'ROSTERED' as const,
        confirmedAt: input.confirmedAt,
        confirmationRevision: 1,
      })),
      expireTentative: vi.fn(),
    };
    const confirm = new ConfirmTentative(repository, () => confirmedAt);

    const result = await confirm.execute({
      groupId,
      gameId,
      registrationId,
      actorUserId,
    });

    expect(result.confirmedAt).toEqual(confirmedAt);
    expect(repository.confirmTentative).toHaveBeenCalledWith({
      groupId,
      gameId,
      registrationId,
      actorUserId,
      confirmedAt,
    });
  });
});

describe('ExpireTentative', () => {
  it('passes the expected confirmation revision to the locked transition', async () => {
    const repository = {
      confirmTentative: vi.fn(),
      expireTentative: vi.fn().mockResolvedValue({ expired: true }),
    };
    const expire = new ExpireTentative(
      repository,
      () => new Date('2026-09-01T13:00:00.000Z'),
    );

    await expire.execute({
      groupId,
      gameId,
      registrationId,
      expectedConfirmationRevision: 0,
    });

    expect(repository.expireTentative).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedConfirmationRevision: 0,
        expiredAt: new Date('2026-09-01T13:00:00.000Z'),
      }),
    );
  });
});
