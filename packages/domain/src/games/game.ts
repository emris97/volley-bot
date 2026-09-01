import type { GroupId } from '../identity.js';
import type {
  Currency,
  GameTemplateId,
  RoundingMode,
} from './game-template.js';

declare const gameIdBrand: unique symbol;

export type GameId = string & { readonly [gameIdBrand]: 'GameId' };

export type GameState =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'OPEN'
  | 'CLOSED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Game {
  id?: GameId;
  groupId?: GroupId;
  sourceTemplateId?: GameTemplateId | null;
  name: string;
  venue: string;
  address: string | null;
  startsAt: Date;
  durationMinutes: number;
  capacity: number;
  timeZone: string;
  registrationOpensAt: Date;
  registrationClosesAt: Date | null;
  tentativePromptAt: Date;
  tentativeResponseDeadline: Date;
  reminderAt: Date;
  memberPriorityEnabled: boolean;
  totalCostMinor: bigint | null;
  currency: Currency;
  roundingMode: RoundingMode;
  state: GameState;
  scheduleRevision: number;
  canonicalTelegramMessageId: bigint | null;
}

export const asGameId = (value: string): GameId => value as GameId;
