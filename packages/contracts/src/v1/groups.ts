import { z } from 'zod';

export const GroupIdSchema = z.uuid();
export const GroupRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'ORGANIZER',
  'MEMBER',
]);

export const ChangeGroupRoleRequestSchema = z.strictObject({
  userId: z.uuid(),
  role: GroupRoleSchema,
});

export const GroupResponseSchema = z.strictObject({
  id: GroupIdSchema,
  title: z.string().min(1),
  timeZone: z.string().min(1),
  enabled: z.boolean(),
});

export type ChangeGroupRoleRequest = z.infer<
  typeof ChangeGroupRoleRequestSchema
>;
export type GroupResponse = z.infer<typeof GroupResponseSchema>;
