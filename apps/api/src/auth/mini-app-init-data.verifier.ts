import { createHmac, timingSafeEqual } from 'node:crypto';
import { asTelegramId, type TelegramId } from '@volley/domain';

const MAX_AUTH_AGE_SECONDS = 300;
const FIELD_NAME = /^[A-Za-z0-9_]+$/;
const SHA_256_HEX = /^[A-Fa-f0-9]{64}$/;
const UNSAFE_CANONICAL_VALUE = /[\r\n]/;

export interface TelegramMiniAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
}

export interface VerifiedMiniAppInitData {
  authDate: Date;
  telegramUserId: TelegramId;
  user: TelegramMiniAppUser;
}

export class MiniAppInitDataVerifier {
  public constructor(private readonly botToken: string) {}

  public verify(
    rawInitData: string,
    now = new Date(),
  ): VerifiedMiniAppInitData {
    const fields = parseFields(rawInitData);
    const receivedHash = fields.get('hash');
    if (receivedHash === undefined || !SHA_256_HEX.test(receivedHash)) {
      throw new Error('Malformed init data hash');
    }

    const dataCheckString = [...fields.entries()]
      .filter(([key]) => key !== 'hash')
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData')
      .update(this.botToken)
      .digest();
    const expectedHash = createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest();
    const receivedHashBytes = Buffer.from(receivedHash, 'hex');
    if (
      receivedHashBytes.length !== expectedHash.length ||
      !timingSafeEqual(receivedHashBytes, expectedHash)
    ) {
      throw new Error('Invalid init data signature');
    }

    const authDateRaw = fields.get('auth_date');
    if (authDateRaw === undefined || !/^(?:0|[1-9]\d*)$/.test(authDateRaw)) {
      throw new Error('Malformed auth_date');
    }
    const authDateSeconds = Number(authDateRaw);
    if (!Number.isSafeInteger(authDateSeconds)) {
      throw new Error('Malformed auth_date');
    }
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    if (authDateSeconds > nowSeconds) {
      throw new Error('auth_date is in the future');
    }
    if (nowSeconds - authDateSeconds > MAX_AUTH_AGE_SECONDS) {
      throw new Error('Init data expired');
    }

    const user = parseUser(fields.get('user'));
    return {
      authDate: new Date(authDateSeconds * 1_000),
      telegramUserId: asTelegramId(String(user.id)),
      user,
    };
  }
}

const parseFields = (rawInitData: string): Map<string, string> => {
  if (rawInitData.length === 0) {
    throw new Error('Malformed init data');
  }
  const fields = new Map<string, string>();
  for (const pair of rawInitData.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      throw new Error('Malformed init data');
    }
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
      value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
    } catch {
      throw new Error('Malformed init data encoding');
    }
    if (
      !FIELD_NAME.test(key) ||
      UNSAFE_CANONICAL_VALUE.test(value) ||
      fields.has(key)
    ) {
      if (fields.has(key)) throw new Error(`Duplicate init data field: ${key}`);
      throw new Error('Malformed init data field');
    }
    fields.set(key, value);
  }
  return fields;
};

const parseUser = (value: string | undefined): TelegramMiniAppUser => {
  if (value === undefined) throw new Error('Mini App user is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Malformed Mini App user');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Malformed Mini App user');
  }
  const user = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0 ||
    typeof user.first_name !== 'string' ||
    user.first_name.length === 0
  ) {
    throw new Error('Malformed Mini App user');
  }
  for (const field of ['last_name', 'username', 'language_code', 'photo_url']) {
    if (user[field] !== undefined && typeof user[field] !== 'string') {
      throw new Error('Malformed Mini App user');
    }
  }
  for (const field of ['is_premium', 'allows_write_to_pm']) {
    if (user[field] !== undefined && typeof user[field] !== 'boolean') {
      throw new Error('Malformed Mini App user');
    }
  }
  return parsed as TelegramMiniAppUser;
};
