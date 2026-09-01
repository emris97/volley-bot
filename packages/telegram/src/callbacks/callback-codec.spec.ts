import { asGameId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { CallbackCodec } from './callback-codec.js';

describe('CallbackCodec', () => {
  const codec = new CallbackCodec();
  const gameId = asGameId('123e4567-e89b-12d3-a456-426614174000');

  it('encodes only version, opaque action, and game id', () => {
    const value = codec.encode({ version: 1, action: 'GOING', gameId });
    expect(value).toBe(`v1:go:${gameId}`);
    expect(value).not.toContain('ADMIN');
    expect(value).not.toContain('MEMBER');
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('round-trips supported actions and rejects stale versions', () => {
    expect(codec.decode(codec.tentative(gameId))).toEqual({
      version: 1,
      action: 'TENTATIVE',
      gameId,
    });
    expect(() => codec.decode(`v2:go:${gameId}`)).toThrow(
      /unsupported callback version/i,
    );
    expect(() => codec.decode('v1:go:not-a-uuid')).toThrow(
      /invalid game callback/i,
    );
  });
});
