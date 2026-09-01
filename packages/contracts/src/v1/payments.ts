import { z } from 'zod';
import { GameIdSchema } from './games.js';

export const ChargeStatusSchema = z.enum(['UNPAID', 'PAID', 'WAIVED']);

export const ChangeChargeStatusRequestSchema = z.strictObject({
  status: ChargeStatusSchema,
});

export const PaymentChargeResponseSchema = z.strictObject({
  id: z.uuid(),
  gameId: GameIdSchema,
  participantRef: z.string().min(1),
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.literal('RUB'),
  status: ChargeStatusSchema,
});

export type ChangeChargeStatusRequest = z.infer<
  typeof ChangeChargeStatusRequestSchema
>;
export type PaymentChargeResponse = z.infer<typeof PaymentChargeResponseSchema>;
