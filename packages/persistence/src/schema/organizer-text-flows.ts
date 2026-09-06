import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups } from './groups.js';
import { users } from './users.js';

export const organizerTextFlows = pgTable('organizer_text_flows', {
  actorUserId: uuid('actor_user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id')
    .notNull()
    .references(() => groups.id, { onDelete: 'cascade' }),
  kind: text('kind')
    .$type<
      'PAYMENT' | 'ATTENDANCE' | 'TEMPLATE' | 'GAME_CREATION' | 'GAME_EDIT'
    >()
    .notNull(),
  reference: text('reference'),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});
