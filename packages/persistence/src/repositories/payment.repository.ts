import {
  asAttendanceSnapshotId,
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
  type AttendanceEntry,
  type AttendanceSnapshot,
  type GameId,
  type GroupId,
  type RoundingMode,
  type UserId,
} from '@volley/domain';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceEntries,
  attendanceSnapshots,
  auditEvents,
  chargeStatusEvents,
  games,
  outboxEvents,
  registrations,
  settlementCharges,
  settlements,
} from '../schema/index.js';

type ChargeStatus = 'UNPAID' | 'PAID' | 'WAIVED';

export interface StoredSettlementCharge {
  id: string;
  settlementId: string;
  participantRef: string;
  displayName: string;
  addedManually: boolean;
  amountMinor: bigint;
  status: ChargeStatus;
  createdAt: Date;
}

export interface StoredSettlement {
  id: string;
  groupId: GroupId;
  gameId: GameId;
  attendanceSnapshotId: ReturnType<typeof asAttendanceSnapshotId>;
  attendanceRevision: number;
  revision: number;
  totalMinor: bigint;
  currency: 'RUB';
  roundingMode: RoundingMode;
  allocationOrder: readonly string[];
  collectedMinor: bigint;
  surplusMinor: bigint;
  supersededAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
  charges: readonly StoredSettlementCharge[];
}

interface CreateRevisionInput {
  actorUserId: UserId;
  totalMinor: bigint;
  currency: 'RUB';
  roundingMode: RoundingMode;
  allocationOrder: readonly string[];
  collectedMinor: bigint;
  surplusMinor: bigint;
  charges: ReadonlyArray<{
    participantRef: string;
    displayName: string;
    addedManually: boolean;
    amountMinor: bigint;
  }>;
}

export class PaymentRepository {
  public constructor(private readonly database: Database) {}

  public async findFinalizedAttendance(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
  ): Promise<AttendanceSnapshot | null> {
    const [snapshot] = await this.database
      .select()
      .from(attendanceSnapshots)
      .where(
        and(
          eq(attendanceSnapshots.groupId, groupId),
          eq(attendanceSnapshots.gameId, gameId),
          eq(attendanceSnapshots.revision, attendanceRevision),
          eq(attendanceSnapshots.finalized, true),
        ),
      )
      .limit(1);
    return snapshot === undefined
      ? null
      : readAttendanceSnapshot(this.database, snapshot);
  }

  public async withLockedFinalizedAttendance<T>(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
    callback: (
      snapshot: AttendanceSnapshot,
      changes: {
        createRevision(input: CreateRevisionInput): Promise<StoredSettlement>;
      },
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select({ id: games.id })
        .from(games)
        .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
        .for('update')
        .limit(1);
      if (game === undefined) throw new Error('Game not found');

      const [snapshotRow] = await transaction
        .select()
        .from(attendanceSnapshots)
        .where(
          and(
            eq(attendanceSnapshots.groupId, groupId),
            eq(attendanceSnapshots.gameId, gameId),
            eq(attendanceSnapshots.revision, attendanceRevision),
            eq(attendanceSnapshots.finalized, true),
          ),
        )
        .for('update')
        .limit(1);
      if (snapshotRow === undefined) {
        throw new Error('Finalized attendance revision required');
      }
      const snapshot = await readAttendanceSnapshot(transaction, snapshotRow);
      let revisionCreated = false;
      return callback(snapshot, {
        createRevision: async (input) => {
          if (revisionCreated) {
            throw new Error('Settlement revision already created');
          }
          revisionCreated = true;
          validateRevisionInput(snapshot, input);

          const [latest] = await transaction
            .select()
            .from(settlements)
            .where(
              and(
                eq(settlements.groupId, groupId),
                eq(settlements.gameId, gameId),
              ),
            )
            .orderBy(desc(settlements.revision))
            .for('update')
            .limit(1);
          const now = new Date();
          if (latest !== undefined && latest.supersededAt === null) {
            await transaction
              .update(settlements)
              .set({ supersededAt: now })
              .where(
                and(
                  eq(settlements.groupId, groupId),
                  eq(settlements.id, latest.id),
                  isNull(settlements.supersededAt),
                ),
              );
          }
          const [settlement] = await transaction
            .insert(settlements)
            .values({
              groupId,
              gameId,
              attendanceSnapshotId: snapshot.id,
              attendanceRevision: snapshot.revision,
              revision: (latest?.revision ?? 0) + 1,
              totalMinor: input.totalMinor,
              currency: input.currency,
              roundingMode: input.roundingMode,
              allocationOrder: [...input.allocationOrder],
              collectedMinor: input.collectedMinor,
              surplusMinor: input.surplusMinor,
              createdBy: input.actorUserId,
              createdAt: now,
            })
            .returning();
          if (settlement === undefined) {
            throw new Error('Settlement insert returned no row');
          }
          const chargeRows = await transaction
            .insert(settlementCharges)
            .values(
              input.charges.map((charge) => ({
                settlementId: settlement.id,
                groupId,
                participantRef: charge.participantRef,
                displayName: charge.displayName,
                addedManually: charge.addedManually,
                amountMinor: charge.amountMinor,
                status: 'UNPAID' as const,
                createdAt: now,
              })),
            )
            .returning();
          await transaction.insert(chargeStatusEvents).values(
            chargeRows.map((charge) => ({
              groupId,
              chargeId: charge.id,
              previousStatus: null,
              status: 'UNPAID' as const,
              actorUserId: input.actorUserId,
              occurredAt: now,
            })),
          );
          await transaction.insert(auditEvents).values({
            groupId,
            actorUserId: input.actorUserId,
            eventType:
              latest === undefined
                ? 'SETTLEMENT_FINALIZED'
                : 'SETTLEMENT_CORRECTED',
            entityType: 'SETTLEMENT',
            entityId: settlement.id,
            payload: {
              attendanceRevision: snapshot.revision,
              settlementRevision: settlement.revision,
              chargeCount: chargeRows.length,
            },
          });
          return toStoredSettlement(settlement, chargeRows);
        },
      });
    });
  }

  public async changeChargeStatus(input: {
    groupId: GroupId;
    chargeId: string;
    actorUserId: UserId;
    status: ChargeStatus;
  }): Promise<StoredSettlementCharge> {
    return this.database.transaction(async (transaction) => {
      const [charge] = await transaction
        .select({ charge: settlementCharges })
        .from(settlementCharges)
        .innerJoin(
          settlements,
          eq(settlements.id, settlementCharges.settlementId),
        )
        .where(
          and(
            eq(settlementCharges.groupId, input.groupId),
            eq(settlementCharges.id, input.chargeId),
            eq(settlements.groupId, input.groupId),
            isNull(settlements.supersededAt),
          ),
        )
        .for('update', { of: settlementCharges })
        .limit(1);
      if (charge === undefined) throw new Error('Charge not found');
      if (charge.charge.status === input.status) {
        return toStoredCharge(charge.charge);
      }
      const now = new Date();
      const [updated] = await transaction
        .update(settlementCharges)
        .set({ status: input.status })
        .where(
          and(
            eq(settlementCharges.groupId, input.groupId),
            eq(settlementCharges.id, input.chargeId),
          ),
        )
        .returning();
      if (updated === undefined) throw new Error('Charge not found');
      await transaction.insert(chargeStatusEvents).values({
        groupId: input.groupId,
        chargeId: updated.id,
        previousStatus: charge.charge.status,
        status: input.status,
        actorUserId: input.actorUserId,
        occurredAt: now,
      });
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        eventType: 'CHARGE_STATUS_CHANGED',
        entityType: 'SETTLEMENT_CHARGE',
        entityId: updated.id,
        payload: {
          previousStatus: charge.charge.status,
          status: input.status,
        },
      });
      return toStoredCharge(updated);
    });
  }

  public async enqueueReminders(input: {
    groupId: GroupId;
    actorUserId: UserId;
    chargeIds: readonly string[];
  }): Promise<{ enqueued: number }> {
    const chargeIds = [...new Set(input.chargeIds)];
    if (chargeIds.length === 0 || chargeIds.length !== input.chargeIds.length) {
      throw new Error('Selected charges must be unique and nonempty');
    }
    return this.database.transaction(async (transaction) => {
      const selected = await transaction
        .select({
          charge: settlementCharges,
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
            inArray(settlementCharges.id, chargeIds),
            eq(settlementCharges.status, 'UNPAID'),
            eq(settlements.groupId, input.groupId),
            isNull(settlements.supersededAt),
          ),
        )
        .for('update', { of: settlementCharges });
      if (selected.length !== chargeIds.length) {
        throw new Error('Selected unpaid charge not found');
      }

      const intents = [];
      for (const selectedCharge of selected) {
        const registrationId = registrationIdFromParticipantRef(
          selectedCharge.charge.participantRef,
        );
        if (registrationId === null) {
          throw new Error('Charge has no private reminder recipient');
        }
        const [registration] = await transaction
          .select({ userId: registrations.userId })
          .from(registrations)
          .where(
            and(
              eq(registrations.groupId, input.groupId),
              eq(registrations.id, registrationId),
            ),
          )
          .limit(1);
        if (registration?.userId === null || registration === undefined) {
          throw new Error('Charge has no private reminder recipient');
        }
        intents.push({
          groupId: input.groupId,
          eventType: 'PAYMENT_REMINDER_REQUESTED',
          aggregateType: 'SETTLEMENT_CHARGE',
          aggregateId: selectedCharge.charge.id,
          payload: {
            channel: 'PRIVATE',
            chargeId: selectedCharge.charge.id,
            settlementId: selectedCharge.charge.settlementId,
            recipientUserId: registration.userId,
            amountMinor: selectedCharge.charge.amountMinor.toString(),
            currency: selectedCharge.currency,
          },
        });
      }
      await transaction.insert(outboxEvents).values(intents);
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        eventType: 'PAYMENT_REMINDERS_REQUESTED',
        entityType: 'GROUP',
        entityId: input.groupId,
        payload: { chargeIds },
      });
      return { enqueued: intents.length };
    });
  }
}

const validateRevisionInput = (
  snapshot: AttendanceSnapshot,
  input: CreateRevisionInput,
): void => {
  const billable = snapshot.entries
    .filter((entry) => entry.billable)
    .map((entry) => entry.participantRef)
    .toSorted();
  const chargeRefs = input.charges
    .map((charge) => charge.participantRef)
    .toSorted();
  if (
    JSON.stringify(input.allocationOrder) !== JSON.stringify(billable) ||
    JSON.stringify(chargeRefs) !== JSON.stringify(billable)
  ) {
    throw new Error('Settlement charges must match billable attendance');
  }
  const collectedMinor = input.charges.reduce(
    (sum, charge) => sum + charge.amountMinor,
    0n,
  );
  if (
    collectedMinor !== input.collectedMinor ||
    input.surplusMinor !== input.collectedMinor - input.totalMinor
  ) {
    throw new Error('Settlement totals do not match charges');
  }
};

const readAttendanceSnapshot = async (
  database: Database,
  snapshot: typeof attendanceSnapshots.$inferSelect,
): Promise<AttendanceSnapshot> => {
  const entries = await database
    .select()
    .from(attendanceEntries)
    .where(
      and(
        eq(attendanceEntries.groupId, snapshot.groupId),
        eq(attendanceEntries.snapshotId, snapshot.id),
      ),
    );
  return {
    id: asAttendanceSnapshotId(snapshot.id),
    groupId: asGroupId(snapshot.groupId),
    gameId: asGameId(snapshot.gameId),
    revision: snapshot.revision,
    finalized: snapshot.finalized,
    rosterCandidates: snapshot.rosterCandidates.map((candidate) => ({
      ...candidate,
      sourceRegistrationId: asRegistrationId(candidate.sourceRegistrationId),
    })),
    entries: entries.map(toAttendanceEntry),
  };
};

const toAttendanceEntry = (
  entry: typeof attendanceEntries.$inferSelect,
): AttendanceEntry => ({
  participantRef: entry.participantRef,
  ...(entry.sourceRegistrationId === null
    ? {}
    : { sourceRegistrationId: asRegistrationId(entry.sourceRegistrationId) }),
  displayName: entry.displayName,
  billable: entry.billable,
  addedManually: entry.addedManually,
});

const toStoredSettlement = (
  settlement: typeof settlements.$inferSelect,
  charges: readonly (typeof settlementCharges.$inferSelect)[],
): StoredSettlement => ({
  id: settlement.id,
  groupId: asGroupId(settlement.groupId),
  gameId: asGameId(settlement.gameId),
  attendanceSnapshotId: asAttendanceSnapshotId(settlement.attendanceSnapshotId),
  attendanceRevision: settlement.attendanceRevision,
  revision: settlement.revision,
  totalMinor: settlement.totalMinor,
  currency: settlement.currency,
  roundingMode: settlement.roundingMode,
  allocationOrder: settlement.allocationOrder,
  collectedMinor: settlement.collectedMinor,
  surplusMinor: settlement.surplusMinor,
  supersededAt: settlement.supersededAt,
  createdBy: asUserId(settlement.createdBy),
  createdAt: settlement.createdAt,
  charges: charges.map(toStoredCharge),
});

const toStoredCharge = (
  charge: typeof settlementCharges.$inferSelect,
): StoredSettlementCharge => ({
  id: charge.id,
  settlementId: charge.settlementId,
  participantRef: charge.participantRef,
  displayName: charge.displayName,
  addedManually: charge.addedManually,
  amountMinor: charge.amountMinor,
  status: charge.status,
  createdAt: charge.createdAt,
});

const registrationIdFromParticipantRef = (value: string): string | null => {
  const prefix = 'registration:';
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
};
