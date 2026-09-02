import { z } from 'zod';

export const RegistrationIdSchema = z.uuid();
export const RegistrationStateSchema = z.enum([
  'TENTATIVE',
  'ROSTERED',
  'WAITLISTED',
  'CANCELLED',
]);

export const ChangeRegistrationRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('ADD_NAMED'),
    guestDisplayName: z.string(),
    idempotencyKey: z.string(),
    reason: z.string(),
  }),
  z.strictObject({
    action: z.literal('CANCEL'),
    registrationId: RegistrationIdSchema,
    reason: z.string(),
  }),
]);

export const RegistrationResponseSchema = z.strictObject({
  registrationId: RegistrationIdSchema,
  state: RegistrationStateSchema,
  rosterPosition: z.int().positive().optional(),
  waitlistPosition: z.int().positive().optional(),
});

export type ChangeRegistrationRequest = z.infer<
  typeof ChangeRegistrationRequestSchema
>;
export type RegistrationResponse = z.infer<typeof RegistrationResponseSchema>;
