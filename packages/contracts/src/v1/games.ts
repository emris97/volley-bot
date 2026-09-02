import { z } from 'zod';
import { GroupIdSchema } from './groups.js';

export const GameIdSchema = z.uuid();
export const GameStateSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'OPEN',
  'CLOSED',
  'COMPLETED',
  'CANCELLED',
]);
export const RoundingModeSchema = z.enum(['EXACT', 'UP_1', 'UP_10', 'UP_50']);

export const GameParamsSchema = z.strictObject({
  groupId: GroupIdSchema,
  gameId: GameIdSchema,
});

export const GameResponseSchema = z.strictObject({
  id: GameIdSchema,
  groupId: GroupIdSchema,
  name: z.string().min(1),
  venue: z.string().min(1),
  address: z.string().nullable(),
  startsAt: z.iso.datetime(),
  durationMinutes: z.int().positive(),
  capacity: z.int().positive(),
  timeZone: z.string().min(1),
  registrationOpensAt: z.iso.datetime(),
  registrationClosesAt: z.iso.datetime().nullable(),
  memberPriorityEnabled: z.boolean(),
  totalCostMinor: z.string().regex(/^\d+$/).nullable(),
  currency: z.literal('RUB'),
  roundingMode: RoundingModeSchema,
  state: GameStateSchema,
  scheduleRevision: z.int().nonnegative(),
});

export type GameParams = z.infer<typeof GameParamsSchema>;
export type GameResponse = z.infer<typeof GameResponseSchema>;
