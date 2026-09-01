import { randomUUID } from 'node:crypto';
import {
  asGroupId,
  asTelegramId,
  asUserId,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  paymentReminderDeliveries,
  registrations,
  settlementCharges,
  settlements,
  users,
} from '../schema/index.js';

export interface StoredPaymentReminderRecipient {
  groupId: GroupId;
  chargeId: string;
  userId: UserId;
  telegramUserId: ReturnType<typeof asTelegramId>;
  displayName: string;
  amountMinor: bigint;
  currency: 'RUB';
}

export type PaymentReminderTerminalFailure =
  'NO_PRIVATE_RECIPIENT' | 'PRIVATE_CHAT_UNAVAILABLE';

export class PaymentReminderRepository {
  public constructor(private readonly database: Database) {}

  public async findRecipient(input: {
    groupId: string;
    chargeId: string;
    settlementId: string;
  }): Promise<StoredPaymentReminderRecipient | null> {
    const [charge] = await this.database
      .select({
        groupId: settlementCharges.groupId,
        participantRef: settlementCharges.participantRef,
        displayName: settlementCharges.displayName,
        amountMinor: settlementCharges.amountMinor,
        currency: settlements.currency,
      })
      .from(settlementCharges)
      .innerJoin(
        settlements,
        eq(settlements.id, settlementCharges.settlementId),
      )
      .where(
        and(
          eq(settlementCharges.groupId, input.groupId),
          eq(settlementCharges.id, input.chargeId),
          eq(settlementCharges.settlementId, input.settlementId),
          eq(settlementCharges.status, 'UNPAID'),
          eq(settlements.groupId, input.groupId),
          isNull(settlements.supersededAt),
        ),
      )
      .limit(1);
    if (charge === undefined) return null;
    const registrationId = registrationIdFromParticipantRef(
      charge.participantRef,
    );
    if (registrationId === null) return null;
    const [recipient] = await this.database
      .select({ userId: users.id, telegramUserId: users.telegramUserId })
      .from(registrations)
      .innerJoin(users, eq(users.id, registrations.userId))
      .where(
        and(
          eq(registrations.groupId, input.groupId),
          eq(registrations.id, registrationId),
          isNotNull(users.dmAvailableAt),
        ),
      )
      .limit(1);
    if (recipient === undefined) return null;
    return {
      groupId: asGroupId(charge.groupId),
      chargeId: input.chargeId,
      userId: asUserId(recipient.userId),
      telegramUserId: asTelegramId(recipient.telegramUserId.toString()),
      displayName: charge.displayName,
      amountMinor: charge.amountMinor,
      currency: charge.currency,
    };
  }

  public async claimDelivery(
    deterministicJobId: string,
    chargeId: string,
    now = new Date(),
    leaseMs = 300_000,
  ): Promise<
    | { status: 'CLAIMED'; claimToken: string }
    | { status: 'COMPLETED' }
    | { status: 'BUSY' }
  > {
    const claimToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.database.execute<{ claim_token: string }>(sql`
      INSERT INTO payment_reminder_deliveries (
        deterministic_job_id,
        charge_id,
        claim_token,
        claimed_at,
        claim_expires_at
      ) VALUES (
        ${deterministicJobId},
        ${chargeId},
        ${claimToken},
        ${now},
        ${leaseUntil}
      )
      ON CONFLICT (deterministic_job_id, charge_id)
      DO UPDATE SET
        claim_token = EXCLUDED.claim_token,
        claimed_at = EXCLUDED.claimed_at,
        claim_expires_at = EXCLUDED.claim_expires_at
      WHERE payment_reminder_deliveries.delivered_at IS NULL
        AND payment_reminder_deliveries.terminal_failure IS NULL
        AND (
          payment_reminder_deliveries.claim_expires_at IS NULL
          OR payment_reminder_deliveries.claim_expires_at <= ${now}
        )
      RETURNING claim_token
    `);
    if (result.rows.length === 1) {
      return { status: 'CLAIMED', claimToken };
    }
    const [current] = await this.database
      .select({
        deliveredAt: paymentReminderDeliveries.deliveredAt,
        terminalFailure: paymentReminderDeliveries.terminalFailure,
      })
      .from(paymentReminderDeliveries)
      .where(
        and(
          eq(paymentReminderDeliveries.deterministicJobId, deterministicJobId),
          eq(paymentReminderDeliveries.chargeId, chargeId),
        ),
      )
      .limit(1);
    if (current === undefined) {
      throw new Error('Payment reminder delivery claim disappeared');
    }
    return current.deliveredAt !== null || current.terminalFailure !== null
      ? { status: 'COMPLETED' }
      : { status: 'BUSY' };
  }

  public async markDelivered(
    deterministicJobId: string,
    chargeId: string,
    claimToken: string,
  ): Promise<void> {
    const rows = await this.database
      .update(paymentReminderDeliveries)
      .set({
        deliveredAt: new Date(),
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      })
      .where(deliveryClaim(deterministicJobId, chargeId, claimToken))
      .returning({ id: paymentReminderDeliveries.id });
    if (rows.length === 0) throw new Error('Payment reminder claim lost');
  }

  public async markTerminalFailure(
    deterministicJobId: string,
    chargeId: string,
    claimToken: string,
    terminalFailure: PaymentReminderTerminalFailure,
  ): Promise<void> {
    const rows = await this.database
      .update(paymentReminderDeliveries)
      .set({
        terminalFailure,
        claimedAt: null,
        claimExpiresAt: null,
        claimToken: null,
      })
      .where(deliveryClaim(deterministicJobId, chargeId, claimToken))
      .returning({ id: paymentReminderDeliveries.id });
    if (rows.length === 0) throw new Error('Payment reminder claim lost');
  }

  public async releaseDelivery(
    deterministicJobId: string,
    chargeId: string,
    claimToken: string,
  ): Promise<void> {
    await this.database
      .update(paymentReminderDeliveries)
      .set({ claimedAt: null, claimExpiresAt: null, claimToken: null })
      .where(deliveryClaim(deterministicJobId, chargeId, claimToken));
  }

  public async markUnavailable(userId: UserId): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: null, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }
}

const registrationIdFromParticipantRef = (value: string): string | null => {
  const prefix = 'registration:';
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
};

const deliveryClaim = (
  deterministicJobId: string,
  chargeId: string,
  claimToken: string,
) =>
  and(
    eq(paymentReminderDeliveries.deterministicJobId, deterministicJobId),
    eq(paymentReminderDeliveries.chargeId, chargeId),
    eq(paymentReminderDeliveries.claimToken, claimToken),
  );
