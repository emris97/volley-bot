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
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { notificationDeliveries, users } from '../schema/index.js';

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
    scheduleRevision: number,
  ): Promise<readonly NotificationRecipientRecord[]> {
    return this.listByState(groupId, gameId, scheduleRevision, 'TENTATIVE');
  }

  public listRostered(
    groupId: GroupId,
    gameId: GameId,
    scheduleRevision: number,
  ): Promise<readonly NotificationRecipientRecord[]> {
    return this.listByState(groupId, gameId, scheduleRevision, 'ROSTERED');
  }

  public async findByRegistration(
    registrationId: RegistrationId,
  ): Promise<NotificationRecipientRecord | null> {
    const rows = await this.list(sql`
      registration.id = ${registrationId}
      AND registration.state = 'ROSTERED'
    `);
    return rows[0] ?? null;
  }

  public async markUnavailable(telegramUserId: TelegramId): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: null, updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }

  public async claimDelivery(
    deterministicJobId: string,
    registrationId: RegistrationId,
    now = new Date(),
    leaseMs = 300_000,
  ): Promise<
    | { status: 'CLAIMED'; claimToken: string }
    | { status: 'DELIVERED' }
    | { status: 'BUSY' }
  > {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimToken = randomUUID();
    const result = await this.database.execute<{ claim_token: string }>(sql`
      INSERT INTO notification_deliveries (
        deterministic_job_id,
        registration_id,
        claim_token,
        claimed_at,
        claim_expires_at
      ) VALUES (
        ${deterministicJobId},
        ${registrationId},
        ${claimToken},
        ${now},
        ${leaseUntil}
      )
      ON CONFLICT (deterministic_job_id, registration_id)
      DO UPDATE SET
        claim_token = EXCLUDED.claim_token,
        claimed_at = EXCLUDED.claimed_at,
        claim_expires_at = EXCLUDED.claim_expires_at
      WHERE notification_deliveries.delivered_at IS NULL
        AND (
          notification_deliveries.claim_expires_at IS NULL
          OR notification_deliveries.claim_expires_at <= ${now}
        )
      RETURNING claim_token
    `);
    if (result.rows.length === 1) {
      return { status: 'CLAIMED', claimToken };
    }
    const [current] = await this.database
      .select({ deliveredAt: notificationDeliveries.deliveredAt })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.deterministicJobId, deterministicJobId),
          eq(notificationDeliveries.registrationId, registrationId),
        ),
      )
      .limit(1);
    return {
      status: current?.deliveredAt === null ? 'BUSY' : 'DELIVERED',
    };
  }

  public async markDelivered(
    deterministicJobId: string,
    registrationId: RegistrationId,
    claimToken: string,
  ): Promise<void> {
    const rows = await this.database
      .update(notificationDeliveries)
      .set({
        deliveredAt: new Date(),
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      })
      .where(
        and(
          eq(notificationDeliveries.deterministicJobId, deterministicJobId),
          eq(notificationDeliveries.registrationId, registrationId),
          eq(notificationDeliveries.claimToken, claimToken),
        ),
      )
      .returning({ id: notificationDeliveries.id });
    if (rows.length === 0) throw new Error('Notification delivery claim lost');
  }

  public async releaseDelivery(
    deterministicJobId: string,
    registrationId: RegistrationId,
    claimToken: string,
  ): Promise<void> {
    await this.database
      .update(notificationDeliveries)
      .set({ claimedAt: null, claimExpiresAt: null, claimToken: null })
      .where(
        and(
          eq(notificationDeliveries.deterministicJobId, deterministicJobId),
          eq(notificationDeliveries.registrationId, registrationId),
          eq(notificationDeliveries.claimToken, claimToken),
        ),
      );
  }

  private async listByState(
    groupId: GroupId,
    gameId: GameId,
    scheduleRevision: number,
    state: 'TENTATIVE' | 'ROSTERED',
  ): Promise<readonly NotificationRecipientRecord[]> {
    return this.list(sql`
      registration.group_id = ${groupId}
      AND registration.game_id = ${gameId}
      AND registration.state = ${state}
      AND game_row.schedule_revision = ${scheduleRevision}
      AND game_row.state IN ('SCHEDULED', 'OPEN', 'CLOSED')
    `);
  }

  private async list(
    predicate: ReturnType<typeof sql>,
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
      INNER JOIN games AS game_row ON game_row.id = registration.game_id
      LEFT JOIN users AS member ON member.id = registration.user_id
      LEFT JOIN users AS inviter ON inviter.id = registration.inviter_user_id
      WHERE ${predicate}
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
