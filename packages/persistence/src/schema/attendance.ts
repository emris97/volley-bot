import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { registrations } from './registrations.js';

export const attendanceSnapshots = pgTable(
  'attendance_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    finalized: boolean('finalized').default(false).notNull(),
    excludedRegistrationIds: jsonb('excluded_registration_ids')
      .$type<string[]>()
      .default([])
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('attendance_snapshots_game_revision_unique').on(
      table.gameId,
      table.revision,
    ),
    index('attendance_snapshots_group_game_revision_idx').on(
      table.groupId,
      table.gameId,
      table.revision,
    ),
    check('attendance_snapshots_revision_check', sql`${table.revision} > 0`),
  ],
);

export const attendanceEntries = pgTable(
  'attendance_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => attendanceSnapshots.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    participantRef: text('participant_ref').notNull(),
    sourceRegistrationId: uuid('source_registration_id').references(
      () => registrations.id,
      { onDelete: 'restrict' },
    ),
    displayName: text('display_name').notNull(),
    billable: boolean('billable').notNull(),
    addedManually: boolean('added_manually').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('attendance_entries_snapshot_participant_unique').on(
      table.snapshotId,
      table.participantRef,
    ),
    index('attendance_entries_group_snapshot_idx').on(
      table.groupId,
      table.snapshotId,
    ),
    check(
      'attendance_entries_manual_source_check',
      sql`(${table.addedManually} and ${table.sourceRegistrationId} is null) or (not ${table.addedManually} and ${table.sourceRegistrationId} is not null)`,
    ),
  ],
);
