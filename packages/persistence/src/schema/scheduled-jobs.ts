import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { games } from './games.js';
import { groups } from './groups.js';

export type ScheduledJobKind =
  | 'OPEN_REGISTRATION'
  | 'CLOSE_REGISTRATION'
  | 'REQUEST_TENTATIVE_CONFIRMATION'
  | 'EXPIRE_TENTATIVE'
  | 'REMIND_PARTICIPANTS';

export const scheduledJobs = pgTable(
  'scheduled_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    deterministicJobId: text('deterministic_job_id').notNull(),
    kind: text('kind').$type<ScheduledJobKind>().notNull(),
    scheduleRevision: integer('schedule_revision').notNull(),
    runAt: timestamp('run_at', { mode: 'date', withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', {
      mode: 'date',
      withTimezone: true,
    }),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('scheduled_jobs_game_deterministic_id_unique').on(
      table.gameId,
      table.deterministicJobId,
    ),
    index('scheduled_jobs_group_run_at_idx').on(table.groupId, table.runAt),
    index('scheduled_jobs_pending_idx')
      .on(table.runAt)
      .where(sql`${table.completedAt} is null`),
    check(
      'scheduled_jobs_schedule_revision_check',
      sql`${table.scheduleRevision} >= 0`,
    ),
  ],
);
