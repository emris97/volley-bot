import {
  timestamp,
  text,
  uniqueIndex,
  uuid,
  pgTable,
} from 'drizzle-orm/pg-core';
import { registrations } from './registrations.js';

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    deterministicJobId: text('deterministic_job_id').notNull(),
    registrationId: uuid('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at', {
      mode: 'date',
      withTimezone: true,
    }),
    claimExpiresAt: timestamp('claim_expires_at', {
      mode: 'date',
      withTimezone: true,
    }),
    deliveredAt: timestamp('delivered_at', {
      mode: 'date',
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex('notification_deliveries_job_registration_unique').on(
      table.deterministicJobId,
      table.registrationId,
    ),
  ],
);
