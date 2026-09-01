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
    deliveredAt: timestamp('delivered_at', {
      mode: 'date',
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('notification_deliveries_job_registration_unique').on(
      table.deterministicJobId,
      table.registrationId,
    ),
  ],
);
