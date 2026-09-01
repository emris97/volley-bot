import { z } from 'zod';
import { GameIdSchema } from './games.js';

export const RegistrationIdSchema = z.uuid();
export const RegistrationStateSchema = z.enum([
  'TENTATIVE',
  'ROSTERED',
  'WAITLISTED',
  'CANCELLED',
]);

export const ChangeRegistrationRequestSchema = z.strictObject({
  state: RegistrationStateSchema,
});

export const RegistrationResponseSchema = z.strictObject({
  id: RegistrationIdSchema,
  gameId: GameIdSchema,
  displayName: z.string().min(1),
  state: RegistrationStateSchema,
});

export type ChangeRegistrationRequest = z.infer<
  typeof ChangeRegistrationRequestSchema
>;
export type RegistrationResponse = z.infer<typeof RegistrationResponseSchema>;
