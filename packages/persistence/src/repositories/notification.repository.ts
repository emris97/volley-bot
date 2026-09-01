import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  type GameId,
  type GroupId,
  type RegistrationId,
  type TelegramId,
} from '@volley/domain';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { users } from '../schema/index.js';

interface NotificationRow extends Record<string, unknown> {
  registration_id: string;
  group_id: string;
  game_id: string;
  group_chat_id: string;
  kind: 'MEMBER' | 'GUEST';
  telegram_user_id: string | null;
  inviter_telegram_user_id: string | null;
  display_name: string;
  confirmation_revision: number;
}

export interface NotificationRecipientRecord {
  registrationId: RegistrationId;
  groupId: GroupId;
  gameId: GameId;
  groupChatId: TelegramId;
  kind: 'MEMBER' | 'GUEST';
  telegramUserId: TelegramId | null;
  inviterTelegramUserId: TelegramId | null;
  displayName: string;
  confirmationRevision: number;
}

export class NotificationRepository {
  public constructor(private readonly database: Database) {}

  public listTentative(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly NotificationRecipientRecord[]> {
    return this.listByState(groupId, gameId, 'TENTATIVE');
  }

  public listRostered(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly NotificationRecipientRecord[]> {
    return this.listByState(groupId, gameId, 'ROSTERED');
  }

  public async markUnavailable(telegramUserId: TelegramId): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: null, updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }

  private async listByState(
    groupId: GroupId,
    gameId: GameId,
    state: 'TENTATIVE' | 'ROSTERED',
  ): Promise<readonly NotificationRecipientRecord[]> {
    const result = await this.database.execute<NotificationRow>(sql`
      SELECT
        registration.id AS registration_id,
        registration.group_id,
        registration.game_id,
        group_row.telegram_chat_id::text AS group_chat_id,
        registration.kind,
        member.telegram_user_id::text AS telegram_user_id,
        inviter.telegram_user_id::text AS inviter_telegram_user_id,
        COALESCE(
          registration.guest_display_name,
          member.display_name,
          'Игрок ' || member.telegram_user_id::text
        ) AS display_name,
        registration.confirmation_revision
      FROM registrations AS registration
      INNER JOIN groups AS group_row ON group_row.id = registration.group_id
      LEFT JOIN users AS member ON member.id = registration.user_id
      LEFT JOIN users AS inviter ON inviter.id = registration.inviter_user_id
      WHERE registration.group_id = ${groupId}
        AND registration.game_id = ${gameId}
        AND registration.state = ${state}
      ORDER BY registration.created_at, registration.id
    `);
    return result.rows.map((row) => ({
      registrationId: asRegistrationId(row.registration_id),
      groupId: asGroupId(row.group_id),
      gameId: asGameId(row.game_id),
      groupChatId: asTelegramId(row.group_chat_id),
      kind: row.kind,
      telegramUserId:
        row.telegram_user_id === null
          ? null
          : asTelegramId(row.telegram_user_id),
      inviterTelegramUserId:
        row.inviter_telegram_user_id === null
          ? null
          : asTelegramId(row.inviter_telegram_user_id),
      displayName: row.display_name,
      confirmationRevision: row.confirmation_revision,
    }));
  }
}
