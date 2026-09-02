import { z } from 'zod';

export const GroupIdSchema = z.uuid();
export const GroupRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'ORGANIZER',
  'MEMBER',
]);
export const AssignableGroupRoleSchema = z.enum(['ORGANIZER', 'MEMBER']);
export const TelegramUserIdSchema = z.string().regex(/^[1-9]\d*$/);

export const ChangeGroupRoleRequestSchema = z.strictObject({
  targetTelegramId: TelegramUserIdSchema,
  role: AssignableGroupRoleSchema,
});

export const GroupResponseSchema = z.strictObject({
  id: GroupIdSchema,
  telegramChatId: z.string().regex(/^-?[1-9]\d*$/),
  title: z.string().min(1),
  timeZone: z.string().min(1),
  enabled: z.boolean(),
  onboardingState: z.enum(['PENDING', 'CONFIGURING', 'CONFIGURED']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ChangeGroupRoleRequest = z.infer<
  typeof ChangeGroupRoleRequestSchema
>;
export type GroupResponse = z.infer<typeof GroupResponseSchema>;
