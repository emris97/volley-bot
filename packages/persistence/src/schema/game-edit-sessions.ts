import type { GameEditableField } from '@volley/application';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { games } from './games.js';
import { groups } from './groups.js';
import { users } from './users.js';

export const gameEditSessions = pgTable(
  'game_edit_sessions',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    expectedGameRevision: integer('expected_game_revision').notNull(),
    selectedField: text('selected_field').$type<GameEditableField>().notNull(),
    interactionRevision: integer('interaction_revision').default(0).notNull(),
    pendingChanges: jsonb('pending_changes').$type<Record<string, unknown>>(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.groupId, table.actorUserId],
      name: 'game_edit_sessions_pkey',
    }),
    index('game_edit_sessions_actor_updated_idx').on(
      table.actorUserId,
      table.active,
      table.updatedAt,
    ),
    check(
      'game_edit_sessions_game_revision_check',
      sql`${table.expectedGameRevision} >= 0`,
    ),
    check(
      'game_edit_sessions_interaction_revision_check',
      sql`${table.interactionRevision} >= 0`,
    ),
    check(
      'game_edit_sessions_selected_field_check',
      sql`${table.selectedField} in ('name', 'venue', 'address', 'startsAt', 'durationMinutes', 'capacity', 'registrationOpensAt', 'registrationClosesAt', 'tentativePromptAt', 'tentativeResponseDeadline', 'reminderAt', 'memberPriorityEnabled', 'totalCostMinor', 'currency', 'roundingMode')`,
    ),
  ],
);
