import { asGroupId, asTelegramId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { SignedStartToken } from './signed-start-token.js';

const now = new Date('2026-08-31T12:00:00Z');
const validPayload = {
  purpose: 'configure-group' as const,
  groupId: asGroupId('00000000-0000-4000-8000-000000000001'),
  administratorTelegramId: asTelegramId('42'),
  expiresAt: new Date('2026-08-31T12:15:00Z').toISOString(),
};

describe('SignedStartToken', () => {
  it('fits the Telegram deep-link payload limit', () => {
    const signer = new SignedStartToken('a-secret-with-at-least-32-characters');

    expect(signer.sign(validPayload)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('round-trips an authentic configuration payload', () => {
    const signer = new SignedStartToken('a-secret-with-at-least-32-characters');

    expect(signer.verify(signer.sign(validPayload), now)).toEqual(validPayload);
  });

  it('rejects a tampered configuration token', () => {
    const signer = new SignedStartToken('a-secret-with-at-least-32-characters');
    const token = signer.sign(validPayload);

    expect(() => signer.verify(`${token}x`, now)).toThrow(/signature/i);
  });

  it('rejects an expired configuration token', () => {
    const signer = new SignedStartToken('a-secret-with-at-least-32-characters');

    expect(() =>
      signer.verify(
        signer.sign(validPayload),
        new Date('2026-08-31T12:16:00Z'),
      ),
    ).toThrow(/expired/i);
  });
});
