import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { groups } from './groups.js';

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedAt: timestamp('claimed_at', { mode: 'date', withTimezone: true }),
    publishedAt: timestamp('published_at', {
      mode: 'date',
      withTimezone: true,
    }),
    attemptCount: integer('attempt_count').default(0).notNull(),
  },
  (table) => [
    check('outbox_events_attempt_count_check', sql`${table.attemptCount} >= 0`),
    index('outbox_events_unpublished_idx')
      .on(table.occurredAt)
      .where(sql`${table.publishedAt} is null`),
  ],
);
