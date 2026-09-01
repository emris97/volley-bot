import type { GroupId } from '../identity.js';

declare const gameTemplateIdBrand: unique symbol;

export type GameTemplateId = string & {
  readonly [gameTemplateIdBrand]: 'GameTemplateId';
};

export type Currency = 'RUB';
export type RoundingMode = 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';

export interface GameTemplateSnapshot {
  name: string;
  venue: string;
  address: string | null;
  startsAtLocalTime: string;
  durationMinutes: number;
  capacity: number;
  registrationOpensMinutesBefore: number;
  registrationClosesMinutesBefore: number | null;
  tentativePromptMinutesBefore: number;
  tentativeResponseMinutes: number;
  reminderMinutesBefore: number;
  memberPriorityEnabled: boolean;
  defaultTotalCostMinor: bigint | null;
  currency: Currency;
  roundingMode: RoundingMode;
}

export interface GameTemplate extends GameTemplateSnapshot {
  id: GameTemplateId;
  groupId: GroupId;
  createdAt: Date;
  updatedAt: Date;
}

export const asGameTemplateId = (value: string): GameTemplateId =>
  value as GameTemplateId;
