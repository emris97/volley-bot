import {
  asGameId,
  asTelegramId,
  type GameId,
  type TelegramId,
} from '@volley/domain';
import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { guestRegistrationDrafts } from '../schema/index.js';

export interface StoredGuestRegistrationDraft {
  telegramUserId: TelegramId;
  gameId: GameId;
  expiresAt: string;
}

export class GuestRegistrationDraftRepository {
  public constructor(private readonly database: Database) {}

  public async load(
    telegramUserId: TelegramId,
  ): Promise<StoredGuestRegistrationDraft | null> {
    const [row] = await this.database
      .select()
      .from(guestRegistrationDrafts)
      .where(eq(guestRegistrationDrafts.telegramUserId, BigInt(telegramUserId)))
      .limit(1);
    return row === undefined
      ? null
      : {
          telegramUserId: asTelegramId(row.telegramUserId.toString()),
          gameId: asGameId(row.gameId),
          expiresAt: row.expiresAt.toISOString(),
        };
  }

  public async save(draft: StoredGuestRegistrationDraft): Promise<void> {
    await this.database
      .insert(guestRegistrationDrafts)
      .values({
        telegramUserId: BigInt(draft.telegramUserId),
        gameId: draft.gameId,
        expiresAt: new Date(draft.expiresAt),
      })
      .onConflictDoUpdate({
        target: guestRegistrationDrafts.telegramUserId,
        set: {
          gameId: draft.gameId,
          expiresAt: new Date(draft.expiresAt),
          updatedAt: new Date(),
        },
      });
  }

  public async clear(telegramUserId: TelegramId): Promise<void> {
    await this.database
      .delete(guestRegistrationDrafts)
      .where(
        eq(guestRegistrationDrafts.telegramUserId, BigInt(telegramUserId)),
      );
  }
}
