import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MiniAppInitDataVerifier } from './mini-app-init-data.verifier.js';

const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const NOW = new Date('2026-08-31T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const USER = {
  id: 900_719_925_474_099,
  first_name: 'Ada',
  username: 'ada_volley',
};

const sign = (entries: readonly (readonly [string, string])[]): string => {
  const dataCheckString = entries
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
};

const signedInitData = (
  overrides: {
    authDate?: string;
    user?: string;
    extra?: readonly (readonly [string, string])[];
  } = {},
): string => {
  const entries = [
    ['auth_date', overrides.authDate ?? String(NOW_SECONDS)],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', overrides.user ?? JSON.stringify(USER)],
    ...(overrides.extra ?? []),
  ] as const;
  const encoded = entries.map(
    ([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
  );
  return [...encoded, `hash=${sign(entries)}`].join('&');
};

describe('MiniAppInitDataVerifier', () => {
  const verifier = new MiniAppInitDataVerifier(BOT_TOKEN);

  it('verifies Telegram HMAC data and returns the trusted Telegram user', () => {
    expect(verifier.verify(signedInitData(), NOW)).toEqual({
      authDate: NOW,
      telegramUserId: '900719925474099',
      user: USER,
    });
  });

  it('rejects a validly shaped init data hash with an invalid signature', () => {
    const valid = signedInitData();
    const tamperedHash = valid.replace(/.$/, valid.endsWith('0') ? '1' : '0');

    expect(() => verifier.verify(tamperedHash, NOW)).toThrow(/signature/i);
  });

  it('rejects data changed after Telegram signed it', () => {
    const valid = signedInitData();
    const tamperedData = valid.replace(
      encodeURIComponent(JSON.stringify(USER)),
      encodeURIComponent(JSON.stringify({ ...USER, first_name: 'Mallory' })),
    );

    expect(() => verifier.verify(tamperedData, NOW)).toThrow(/signature/i);
  });

  it('accepts init data exactly five minutes old', () => {
    const raw = signedInitData({ authDate: String(NOW_SECONDS - 300) });

    expect(verifier.verify(raw, NOW).telegramUserId).toBe('900719925474099');
  });

  it('rejects init data older than five minutes', () => {
    const raw = signedInitData({ authDate: String(NOW_SECONDS - 301) });

    expect(() => verifier.verify(raw, NOW)).toThrow(/expired/i);
  });

  it('rejects an auth_date from the future', () => {
    const raw = signedInitData({ authDate: String(NOW_SECONDS + 1) });

    expect(() => verifier.verify(raw, NOW)).toThrow(/future/i);
  });

  it.each(['1.5', '1e3', '-1', '+1', '01', ''])(
    'rejects malformed integer auth_date %j',
    (authDate) => {
      const raw = signedInitData({ authDate });

      expect(() => verifier.verify(raw, NOW)).toThrow(/auth_date/i);
    },
  );

  it.each(['hash', 'auth_date', 'user'])(
    'rejects duplicate %s security fields before validation',
    (field) => {
      const raw = signedInitData();
      const value =
        field === 'hash'
          ? '0'.repeat(64)
          : field === 'auth_date'
            ? String(NOW_SECONDS)
            : JSON.stringify(USER);

      expect(() =>
        verifier.verify(`${raw}&${field}=${encodeURIComponent(value)}`, NOW),
      ).toThrow(/duplicate/i);
    },
  );

  it.each([
    'auth_date=1&user=%ZZ&hash=' + '0'.repeat(64),
    'auth_date=1&user=%7B%7D&hash=not-hex',
    signedInitData({ user: '{not-json}' }),
    signedInitData({ user: JSON.stringify({ first_name: 'No id' }) }),
    signedInitData({
      extra: [['unsafe', 'first line\nadmin=true']],
    }),
  ])('rejects malformed or unsafe init data %#', (raw) => {
    expect(() => verifier.verify(raw, NOW)).toThrow(/malformed|user|hash/i);
  });
});
