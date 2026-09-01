import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  asGroupId,
  asTelegramId,
  type GroupId,
  type TelegramId,
} from '@volley/domain';

export interface ConfigureGroupStartPayload {
  purpose: 'configure-group';
  groupId: GroupId;
  administratorTelegramId: TelegramId;
  expiresAt: string;
}

const encode = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64url');

export class SignedStartToken {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('Start token secret must contain at least 32 bytes');
    }
  }

  sign(payload: ConfigureGroupStartPayload): string {
    const encodedPayload = encode(JSON.stringify(payload));
    return `${encodedPayload}.${this.signature(encodedPayload)}`;
  }

  verify(token: string, now = new Date()): ConfigureGroupStartPayload {
    const parts = token.split('.');
    const encodedPayload = parts[0];
    const signature = parts[1];
    if (
      parts.length !== 2 ||
      encodedPayload === undefined ||
      signature === undefined
    ) {
      throw new Error('Invalid token signature');
    }

    const expected = Buffer.from(this.signature(encodedPayload));
    const actual = Buffer.from(signature);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error('Invalid token signature');
    }

    let value: unknown;
    try {
      value = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      );
    } catch {
      throw new Error('Invalid token payload');
    }
    if (!isPayload(value)) {
      throw new Error('Invalid token payload');
    }
    if (Date.parse(value.expiresAt) <= now.getTime()) {
      throw new Error('Start token expired');
    }

    return {
      purpose: 'configure-group',
      groupId: asGroupId(value.groupId),
      administratorTelegramId: asTelegramId(value.administratorTelegramId),
      expiresAt: value.expiresAt,
    };
  }

  private signature(encodedPayload: string): string {
    return createHmac('sha256', this.secret)
      .update(encodedPayload)
      .digest('base64url');
  }
}

const isPayload = (
  value: unknown,
): value is {
  purpose: 'configure-group';
  groupId: string;
  administratorTelegramId: string;
  expiresAt: string;
} => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.purpose === 'configure-group' &&
    typeof candidate.groupId === 'string' &&
    typeof candidate.administratorTelegramId === 'string' &&
    typeof candidate.expiresAt === 'string' &&
    Number.isFinite(Date.parse(candidate.expiresAt))
  );
};
