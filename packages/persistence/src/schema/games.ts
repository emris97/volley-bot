import type { GameState, RoundingMode } from '@volley/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { groups } from './groups.js';

export const gameTemplates = pgTable(
  'game_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    venue: text('venue').notNull(),
    address: text('address'),
    startsAtLocalTime: text('starts_at_local_time').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    capacity: integer('capacity').notNull(),
    registrationOpensMinutesBefore: integer(
      'registration_opens_minutes_before',
    ).notNull(),
    registrationClosesMinutesBefore: integer(
      'registration_closes_minutes_before',
    ),
    tentativePromptMinutesBefore: integer(
      'tentative_prompt_minutes_before',
    ).notNull(),
    tentativeResponseMinutes: integer('tentative_response_minutes').notNull(),
    reminderMinutesBefore: integer('reminder_minutes_before').notNull(),
    memberPriorityEnabled: boolean('member_priority_enabled').notNull(),
    defaultTotalCostMinor: bigint('default_total_cost_minor', {
      mode: 'bigint',
    }),
    currency: text('currency').default('RUB').notNull(),
    roundingMode: text('rounding_mode')
      .$type<RoundingMode>()
      .default('EXACT')
      .notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('game_templates_group_id_idx').on(table.groupId),
    check('game_templates_capacity_check', sql`${table.capacity} > 0`),
    check(
      'game_templates_duration_check',
      sql`${table.durationMinutes} > 0`,
    ),
    check(
      'game_templates_timing_check',
      sql`${table.registrationOpensMinutesBefore} >= 0 and (${table.registrationClosesMinutesBefore} is null or ${table.registrationClosesMinutesBefore} >= 0) and ${table.tentativePromptMinutesBefore} >= 0 and ${table.tentativeResponseMinutes} >= 0 and ${table.reminderMinutesBefore} >= 0`,
    ),
    check(
      'game_templates_currency_check',
      sql`${table.currency} in ('RUB')`,
    ),
    check(
      'game_templates_rounding_mode_check',
      sql`${table.roundingMode} in ('EXACT', 'UP_1', 'UP_10', 'UP_50')`,
    ),
    check(
      'game_templates_cost_check',
      sql`${table.defaultTotalCostMinor} is null or ${table.defaultTotalCostMinor} >= 0`,
    ),
  ],
);

export const games = pgTable(
  'games',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    sourceTemplateId: uuid('source_template_id').references(
      () => gameTemplates.id,
      { onDelete: 'set null' },
    ),
    name: text('name').notNull(),
    venue: text('venue').notNull(),
    address: text('address'),
    startsAt: timestamp('starts_at', { mode: 'date', withTimezone: true })
      .notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    capacity: integer('capacity').notNull(),
    timeZone: text('time_zone').notNull(),
    registrationOpensAt: timestamp('registration_opens_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    registrationClosesAt: timestamp('registration_closes_at', {
      mode: 'date',
      withTimezone: true,
    }),
    tentativePromptAt: timestamp('tentative_prompt_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    tentativeResponseDeadline: timestamp('tentative_response_deadline', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    reminderAt: timestamp('reminder_at', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    memberPriorityEnabled: boolean('member_priority_enabled').notNull(),
    totalCostMinor: bigint('total_cost_minor', { mode: 'bigint' }),
    currency: text('currency').default('RUB').notNull(),
    roundingMode: text('rounding_mode')
      .$type<RoundingMode>()
      .default('EXACT')
      .notNull(),
    state: text('state').$type<GameState>().default('DRAFT').notNull(),
    scheduleRevision: integer('schedule_revision').default(0).notNull(),
    canonicalTelegramMessageId: bigint('canonical_telegram_message_id', {
      mode: 'bigint',
    }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('games_group_starts_at_idx').on(table.groupId, table.startsAt),
    check('games_capacity_check', sql`${table.capacity} > 0`),
    check('games_duration_check', sql`${table.durationMinutes} > 0`),
    check(
      'games_state_check',
      sql`${table.state} in ('DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED')`,
    ),
    check('games_schedule_revision_check', sql`${table.scheduleRevision} >= 0`),
    check('games_currency_check', sql`${table.currency} in ('RUB')`),
    check(
      'games_rounding_mode_check',
      sql`${table.roundingMode} in ('EXACT', 'UP_1', 'UP_10', 'UP_50')`,
    ),
    check(
      'games_cost_check',
      sql`${table.totalCostMinor} is null or ${table.totalCostMinor} >= 0`,
    ),
    check(
      'games_time_order_check',
      sql`${table.registrationOpensAt} <= ${table.startsAt} and (${table.registrationClosesAt} is null or (${table.registrationClosesAt} >= ${table.registrationOpensAt} and ${table.registrationClosesAt} <= ${table.startsAt})) and ${table.tentativePromptAt} <= ${table.tentativeResponseDeadline} and ${table.tentativeResponseDeadline} <= ${table.startsAt} and ${table.reminderAt} <= ${table.startsAt}`,
    ),
  ],
);
