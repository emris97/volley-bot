import { bigint, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { games } from './games.js';

export const guestRegistrationDrafts = pgTable('guest_registration_drafts', {
  telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).primaryKey(),
  gameId: uuid('game_id')
    .notNull()
    .references(() => games.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});
