import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  asGameId,
  asGroupId,
  asTelegramId,
  type GameId,
  type GroupId,
  type TelegramId,
} from '@volley/domain';

export interface ConfigureGroupStartPayload {
  purpose: 'configure-group';
  groupId: GroupId;
  administratorTelegramId: TelegramId;
  expiresAt: string;
}

export interface AddGuestStartPayload {
  purpose: 'add-guest';
  gameId: GameId;
  inviterTelegramId: TelegramId;
  expiresAt: string;
}

export type StartPayload = ConfigureGroupStartPayload | AddGuestStartPayload;

export type StartTokenVerificationFailure = 'INVALID' | 'EXPIRED';

export class StartTokenVerificationError extends Error {
  public constructor(public readonly reason: StartTokenVerificationFailure) {
    super(`Start token ${reason.toLowerCase()}`);
    this.name = 'StartTokenVerificationError';
  }
}

const configurePurpose = 1;
const addGuestPurpose = 2;
const bodyLength = 29;
const tagLength = 16;
const tokenLength = bodyLength + tagLength;
const maxTelegramId = (1n << 64n) - 1n;

export class SignedStartToken {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) {
      throw new Error('Start token secret must contain at least 32 bytes');
    }
  }

  sign(payload: StartPayload): string {
    const entityId = uuidBytes(
      payload.purpose === 'configure-group' ? payload.groupId : payload.gameId,
    );
    const administratorTelegramId = parseAdministratorId(
      payload.purpose === 'configure-group'
        ? payload.administratorTelegramId
        : payload.inviterTelegramId,
    );
    const expiresAtSeconds = Math.floor(Date.parse(payload.expiresAt) / 1000);
    if (
      !Number.isSafeInteger(expiresAtSeconds) ||
      expiresAtSeconds <= 0 ||
      expiresAtSeconds > 0xffff_ffff
    ) {
      throw new Error('Invalid token expiry');
    }

    const body = Buffer.alloc(bodyLength);
    body.writeUInt8(
      payload.purpose === 'configure-group'
        ? configurePurpose
        : addGuestPurpose,
      0,
    );
    entityId.copy(body, 1);
    body.writeBigUInt64BE(administratorTelegramId, 17);
    body.writeUInt32BE(expiresAtSeconds, 25);
    return Buffer.concat([body, this.signature(body)]).toString('base64url');
  }

  verify(token: string, now = new Date()): StartPayload {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) {
      throw new StartTokenVerificationError('INVALID');
    }
    const bytes = Buffer.from(token, 'base64url');
    if (
      bytes.toString('base64url') !== token ||
      bytes.length !== tokenLength ||
      ![configurePurpose, addGuestPurpose].includes(bytes.readUInt8(0))
    ) {
      throw new StartTokenVerificationError('INVALID');
    }

    const body = bytes.subarray(0, bodyLength);
    const actualTag = bytes.subarray(bodyLength);
    const expectedTag = this.signature(body);
    if (!timingSafeEqual(actualTag, expectedTag)) {
      throw new StartTokenVerificationError('INVALID');
    }

    const expiresAtMilliseconds = body.readUInt32BE(25) * 1000;
    if (expiresAtMilliseconds <= now.getTime()) {
      throw new StartTokenVerificationError('EXPIRED');
    }

    const telegramId = asTelegramId(body.readBigUInt64BE(17).toString());
    const expiresAt = new Date(expiresAtMilliseconds).toISOString();
    return body.readUInt8(0) === configurePurpose
      ? {
          purpose: 'configure-group',
          groupId: asGroupId(formatUuid(body.subarray(1, 17))),
          administratorTelegramId: telegramId,
          expiresAt,
        }
      : {
          purpose: 'add-guest',
          gameId: asGameId(formatUuid(body.subarray(1, 17))),
          inviterTelegramId: telegramId,
          expiresAt,
        };
  }

  private signature(body: Buffer): Buffer {
    return createHmac('sha256', this.secret)
      .update(body)
      .digest()
      .subarray(0, tagLength);
  }
}

const uuidBytes = (entityId: GroupId | GameId): Buffer => {
  const compact = entityId.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new Error('Invalid group UUID');
  }
  return Buffer.from(compact, 'hex');
};

const formatUuid = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const parseAdministratorId = (telegramId: TelegramId): bigint => {
  if (!/^\d+$/.test(telegramId)) throw new Error('Invalid administrator ID');
  const value = BigInt(telegramId);
  if (value > maxTelegramId) throw new Error('Invalid administrator ID');
  return value;
};
