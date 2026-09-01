import type { RoundingMode } from '@volley/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
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
import { attendanceSnapshots } from './attendance.js';
import { games } from './games.js';
import { groups } from './groups.js';
import { users } from './users.js';

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'restrict' }),
    attendanceSnapshotId: uuid('attendance_snapshot_id')
      .notNull()
      .references(() => attendanceSnapshots.id, { onDelete: 'restrict' }),
    attendanceRevision: integer('attendance_revision').notNull(),
    revision: integer('revision').notNull(),
    totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').$type<'RUB'>().notNull(),
    roundingMode: text('rounding_mode').$type<RoundingMode>().notNull(),
    allocationOrder: jsonb('allocation_order').$type<string[]>().notNull(),
    collectedMinor: bigint('collected_minor', { mode: 'bigint' }).notNull(),
    surplusMinor: bigint('surplus_minor', { mode: 'bigint' }).notNull(),
    supersededAt: timestamp('superseded_at', {
      mode: 'date',
      withTimezone: true,
    }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('settlements_game_revision_unique').on(
      table.gameId,
      table.revision,
    ),
    index('settlements_group_game_revision_idx').on(
      table.groupId,
      table.gameId,
      table.revision,
    ),
    uniqueIndex('settlements_active_game_unique')
      .on(table.gameId)
      .where(sql`${table.supersededAt} is null`),
    check('settlements_revision_check', sql`${table.revision} > 0`),
    check(
      'settlements_attendance_revision_check',
      sql`${table.attendanceRevision} > 0`,
    ),
    check(
      'settlements_amounts_check',
      sql`${table.totalMinor} >= 0 and ${table.collectedMinor} >= 0 and ${table.surplusMinor} >= 0 and ${table.collectedMinor} = ${table.totalMinor} + ${table.surplusMinor}`,
    ),
    check('settlements_currency_check', sql`${table.currency} in ('RUB')`),
    check(
      'settlements_rounding_mode_check',
      sql`${table.roundingMode} in ('EXACT', 'UP_1', 'UP_10', 'UP_50')`,
    ),
  ],
);

export const settlementCharges = pgTable(
  'settlement_charges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => settlements.id, { onDelete: 'restrict' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    participantRef: text('participant_ref').notNull(),
    displayName: text('display_name').notNull(),
    addedManually: boolean('added_manually').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    status: text('status')
      .$type<'UNPAID' | 'PAID' | 'WAIVED'>()
      .default('UNPAID')
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('settlement_charges_settlement_participant_unique').on(
      table.settlementId,
      table.participantRef,
    ),
    index('settlement_charges_group_settlement_idx').on(
      table.groupId,
      table.settlementId,
    ),
    check('settlement_charges_amount_check', sql`${table.amountMinor} >= 0`),
    check(
      'settlement_charges_status_check',
      sql`${table.status} in ('UNPAID', 'PAID', 'WAIVED')`,
    ),
  ],
);

export const chargeStatusEvents = pgTable(
  'charge_status_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'restrict' }),
    chargeId: uuid('charge_id')
      .notNull()
      .references(() => settlementCharges.id, { onDelete: 'restrict' }),
    previousStatus: text('previous_status').$type<
      'UNPAID' | 'PAID' | 'WAIVED'
    >(),
    status: text('status').$type<'UNPAID' | 'PAID' | 'WAIVED'>().notNull(),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('charge_status_events_group_charge_occurred_idx').on(
      table.groupId,
      table.chargeId,
      table.occurredAt,
    ),
    check(
      'charge_status_events_previous_status_check',
      sql`${table.previousStatus} is null or ${table.previousStatus} in ('UNPAID', 'PAID', 'WAIVED')`,
    ),
    check(
      'charge_status_events_status_check',
      sql`${table.status} in ('UNPAID', 'PAID', 'WAIVED')`,
    ),
  ],
);
