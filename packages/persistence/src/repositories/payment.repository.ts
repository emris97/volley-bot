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
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceEntries,
  attendanceSnapshots,
  auditEvents,
  chargeStatusEvents,
  games,
  outboxEvents,
  paymentDrafts,
  paymentInputSessions,
  registrations,
  settlementCharges,
  settlements,
  users,
} from '../schema/index.js';

type ChargeStatus = 'UNPAID' | 'PAID' | 'WAIVED';

export interface StoredPaymentDraft {
  id: string;
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  attendanceRevision: number;
  totalAmount: string;
  currency: 'RUB';
  roundingMode: RoundingMode;
  expiresAt: Date;
  finalizedSettlementId: string | null;
}

export interface StoredPaymentInputSession {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  attendanceRevision: number;
  currency: 'RUB';
  roundingMode: RoundingMode;
  expiresAt: Date;
}

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

  public async saveDraft(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
    attendanceRevision: number;
    totalAmount: string;
    currency: 'RUB';
    roundingMode: RoundingMode;
  }): Promise<StoredPaymentDraft> {
    const [draft] = await this.database
      .insert(paymentDrafts)
      .values({
        ...input,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      })
      .returning();
    if (draft === undefined)
      throw new Error('Payment draft insert returned no row');
    return toStoredPaymentDraft(draft);
  }

  public async findDraft(
    groupId: GroupId,
    draftId: string,
  ): Promise<StoredPaymentDraft | null> {
    const [draft] = await this.database
      .select()
      .from(paymentDrafts)
      .where(
        and(
          eq(paymentDrafts.groupId, groupId),
          eq(paymentDrafts.id, draftId),
          gt(paymentDrafts.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return draft === undefined ? null : toStoredPaymentDraft(draft);
  }

  public async deleteDraft(groupId: GroupId, draftId: string): Promise<void> {
    await this.database
      .delete(paymentDrafts)
      .where(
        and(eq(paymentDrafts.groupId, groupId), eq(paymentDrafts.id, draftId)),
      );
  }

  public async beginInput(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
  }): Promise<StoredPaymentInputSession> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select({
          currency: games.currency,
          roundingMode: games.roundingMode,
        })
        .from(games)
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        )
        .limit(1);
      if (game === undefined) throw new Error('Game not found');
      if (game.currency !== 'RUB') {
        throw new Error('Settlement currency must be RUB');
      }
      const [attendance] = await transaction
        .select({ revision: attendanceSnapshots.revision })
        .from(attendanceSnapshots)
        .where(
          and(
            eq(attendanceSnapshots.groupId, input.groupId),
            eq(attendanceSnapshots.gameId, input.gameId),
            eq(attendanceSnapshots.finalized, true),
          ),
        )
        .orderBy(desc(attendanceSnapshots.revision))
        .limit(1);
      if (attendance === undefined) {
        throw new Error('Finalized attendance revision required');
      }
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const [session] = await transaction
        .insert(paymentInputSessions)
        .values({
          ...input,
          attendanceRevision: attendance.revision,
          currency: 'RUB',
          roundingMode: game.roundingMode,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: paymentInputSessions.actorUserId,
          set: {
            groupId: input.groupId,
            gameId: input.gameId,
            attendanceRevision: attendance.revision,
            currency: 'RUB',
            roundingMode: game.roundingMode,
            expiresAt,
            createdAt: new Date(),
          },
        })
        .returning();
      if (session === undefined) {
        throw new Error('Payment input session insert returned no row');
      }
      return toStoredPaymentInputSession(session);
    });
  }

  public async findInputByTelegramUserId(
    telegramUserId: TelegramId,
  ): Promise<StoredPaymentInputSession | null> {
    const [session] = await this.database
      .select({ session: paymentInputSessions })
      .from(paymentInputSessions)
      .innerJoin(users, eq(users.id, paymentInputSessions.actorUserId))
      .where(
        and(
          eq(users.telegramUserId, BigInt(telegramUserId)),
          gt(paymentInputSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return session === undefined
      ? null
      : toStoredPaymentInputSession(session.session);
  }

  public async clearInput(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<void> {
    await this.database
      .delete(paymentInputSessions)
      .where(
        and(
          eq(paymentInputSessions.groupId, groupId),
          eq(paymentInputSessions.actorUserId, actorUserId),
        ),
      );
  }

  public async findActiveSettlement(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<StoredSettlement | null> {
    const [settlement] = await this.database
      .select()
      .from(settlements)
      .where(
        and(
          eq(settlements.groupId, groupId),
          eq(settlements.gameId, gameId),
          isNull(settlements.supersededAt),
        ),
      )
      .limit(1);
    return settlement === undefined
      ? null
      : readStoredSettlement(this.database, settlement);
  }

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

  public async withLockedFinalizedAttendance(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
    callback: (
      snapshot: AttendanceSnapshot,
      changes: {
        createRevision(input: CreateRevisionInput): Promise<StoredSettlement>;
      },
    ) => Promise<StoredSettlement>,
  ): Promise<StoredSettlement> {
    return this.finalizeLocked(
      groupId,
      gameId,
      attendanceRevision,
      null,
      callback,
    );
  }

  public async finalizeDraft(
    input: {
      groupId: GroupId;
      gameId: GameId;
      attendanceRevision: number;
      draftId: string;
      actorUserId: UserId;
    },
    callback: (
      snapshot: AttendanceSnapshot,
      changes: {
        createRevision(input: CreateRevisionInput): Promise<StoredSettlement>;
      },
    ) => Promise<StoredSettlement>,
  ): Promise<StoredSettlement> {
    return this.finalizeLocked(
      input.groupId,
      input.gameId,
      input.attendanceRevision,
      { id: input.draftId, actorUserId: input.actorUserId },
      callback,
    );
  }

  private async finalizeLocked(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
    draftContext: { id: string; actorUserId: UserId } | null,
    callback: (
      snapshot: AttendanceSnapshot,
      changes: {
        createRevision(input: CreateRevisionInput): Promise<StoredSettlement>;
      },
    ) => Promise<StoredSettlement>,
  ): Promise<StoredSettlement> {
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
      const lockedDraft =
        draftContext === null
          ? null
          : await lockPaymentDraft(transaction, {
              groupId,
              gameId,
              attendanceRevision,
              draftId: draftContext.id,
              actorUserId: draftContext.actorUserId,
            });
      if (lockedDraft !== null && lockedDraft.finalizedSettlementId !== null) {
        const [finalized] = await transaction
          .select()
          .from(settlements)
          .where(
            and(
              eq(settlements.groupId, groupId),
              eq(settlements.id, lockedDraft.finalizedSettlementId),
            ),
          )
          .limit(1);
        if (finalized === undefined) {
          throw new Error('Finalized draft settlement not found');
        }
        return readStoredSettlement(transaction, finalized);
      }
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
          if (lockedDraft !== null) {
            await transaction
              .update(paymentDrafts)
              .set({ finalizedSettlementId: settlement.id })
              .where(
                and(
                  eq(paymentDrafts.groupId, groupId),
                  eq(paymentDrafts.id, lockedDraft.id),
                  eq(paymentDrafts.actorUserId, lockedDraft.actorUserId),
                  isNull(paymentDrafts.finalizedSettlementId),
                ),
              );
          }
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
      const [context] = await transaction
        .select({ gameId: settlements.gameId })
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
          ),
        )
        .limit(1);
      if (context === undefined) throw new Error('Charge not found');
      await lockGame(transaction, input.groupId, asGameId(context.gameId));

      const [activeSettlement] = await transaction
        .select({ id: settlements.id })
        .from(settlements)
        .innerJoin(
          settlementCharges,
          eq(settlementCharges.settlementId, settlements.id),
        )
        .where(
          and(
            eq(settlements.groupId, input.groupId),
            eq(settlements.gameId, context.gameId),
            eq(settlementCharges.groupId, input.groupId),
            eq(settlementCharges.id, input.chargeId),
            isNull(settlements.supersededAt),
          ),
        )
        .for('update', { of: settlements })
        .limit(1);
      if (activeSettlement === undefined) throw new Error('Charge not found');

      const [charge] = await transaction
        .select()
        .from(settlementCharges)
        .where(
          and(
            eq(settlementCharges.groupId, input.groupId),
            eq(settlementCharges.id, input.chargeId),
            eq(settlementCharges.settlementId, activeSettlement.id),
          ),
        )
        .for('update')
        .limit(1);
      if (charge === undefined) throw new Error('Charge not found');
      if (charge.status === input.status) {
        return toStoredCharge(charge);
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
        previousStatus: charge.status,
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
          previousStatus: charge.status,
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
      const contexts = await transaction
        .select({
          chargeId: settlementCharges.id,
          gameId: settlements.gameId,
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
            eq(settlements.groupId, input.groupId),
          ),
        );
      if (contexts.length !== chargeIds.length) {
        throw new Error('Selected unpaid charge not found');
      }
      const gameIds = [...new Set(contexts.map((context) => context.gameId))]
        .sort()
        .map(asGameId);
      for (const gameId of gameIds) {
        await lockGame(transaction, input.groupId, gameId);
      }

      const activeSettlements = await transaction
        .select({
          chargeId: settlementCharges.id,
          settlementId: settlements.id,
        })
        .from(settlements)
        .innerJoin(
          settlementCharges,
          eq(settlementCharges.settlementId, settlements.id),
        )
        .where(
          and(
            eq(settlements.groupId, input.groupId),
            eq(settlementCharges.groupId, input.groupId),
            inArray(settlementCharges.id, chargeIds),
            isNull(settlements.supersededAt),
          ),
        )
        .for('update', { of: settlements });
      if (activeSettlements.length !== chargeIds.length) {
        throw new Error('Selected unpaid charge not found');
      }

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

const lockGame = async (
  database: Database,
  groupId: GroupId,
  gameId: GameId,
): Promise<void> => {
  const [game] = await database
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
    .for('update')
    .limit(1);
  if (game === undefined) throw new Error('Game not found');
};

const lockPaymentDraft = async (
  database: Database,
  input: {
    groupId: GroupId;
    gameId: GameId;
    attendanceRevision: number;
    draftId: string;
    actorUserId: UserId;
  },
) => {
  const [draft] = await database
    .select()
    .from(paymentDrafts)
    .where(
      and(
        eq(paymentDrafts.groupId, input.groupId),
        eq(paymentDrafts.gameId, input.gameId),
        eq(paymentDrafts.attendanceRevision, input.attendanceRevision),
        eq(paymentDrafts.id, input.draftId),
        eq(paymentDrafts.actorUserId, input.actorUserId),
        gt(paymentDrafts.expiresAt, new Date()),
      ),
    )
    .for('update')
    .limit(1);
  if (draft === undefined) throw new Error('Payment preview not found');
  return draft;
};

const readStoredSettlement = async (
  database: Database,
  settlement: typeof settlements.$inferSelect,
): Promise<StoredSettlement> => {
  const charges = await database
    .select()
    .from(settlementCharges)
    .where(
      and(
        eq(settlementCharges.groupId, settlement.groupId),
        eq(settlementCharges.settlementId, settlement.id),
      ),
    );
  const order = new Map(
    settlement.allocationOrder.map((participantRef, index) => [
      participantRef,
      index,
    ]),
  );
  charges.sort(
    (left, right) =>
      (order.get(left.participantRef) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.participantRef) ?? Number.MAX_SAFE_INTEGER),
  );
  return toStoredSettlement(settlement, charges);
};

const toStoredPaymentDraft = (
  draft: typeof paymentDrafts.$inferSelect,
): StoredPaymentDraft => ({
  id: draft.id,
  groupId: asGroupId(draft.groupId),
  gameId: asGameId(draft.gameId),
  actorUserId: asUserId(draft.actorUserId),
  attendanceRevision: draft.attendanceRevision,
  totalAmount: draft.totalAmount,
  currency: draft.currency,
  roundingMode: draft.roundingMode,
  expiresAt: draft.expiresAt,
  finalizedSettlementId: draft.finalizedSettlementId,
});

const toStoredPaymentInputSession = (
  session: typeof paymentInputSessions.$inferSelect,
): StoredPaymentInputSession => ({
  groupId: asGroupId(session.groupId),
  gameId: asGameId(session.gameId),
  actorUserId: asUserId(session.actorUserId),
  attendanceRevision: session.attendanceRevision,
  currency: session.currency,
  roundingMode: session.roundingMode,
  expiresAt: session.expiresAt,
});
