import { z } from 'zod';
export const ChargeStatusSchema = z.enum(['UNPAID', 'PAID', 'WAIVED']);

export const ChangeChargeStatusRequestSchema = z.strictObject({
  status: ChargeStatusSchema,
});

export const PaymentChargeResponseSchema = z.strictObject({
  id: z.uuid(),
  settlementId: z.uuid(),
  participantRef: z.string().min(1),
  displayName: z.string(),
  addedManually: z.boolean(),
  amountMinor: z.string().regex(/^\d+$/),
  status: ChargeStatusSchema,
  createdAt: z.iso.datetime(),
});

export type ChangeChargeStatusRequest = z.infer<
  typeof ChangeChargeStatusRequestSchema
>;
export type PaymentChargeResponse = z.infer<typeof PaymentChargeResponseSchema>;
