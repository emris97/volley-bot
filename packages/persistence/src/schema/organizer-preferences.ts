import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { groups } from './groups.js';
import { users } from './users.js';

export const organizerPreferences = pgTable('organizer_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  selectedGroupId: uuid('selected_group_id').references(() => groups.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});
