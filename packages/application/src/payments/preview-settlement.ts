import {
  calculateSettlement,
  rubles,
  type AttendanceSnapshot,
  type GameId,
  type GroupId,
  type RoundingMode,
  type UserId,
} from '@volley/domain';
import type {
  PaymentAuthorization,
  PaymentRepository,
  SettlementChargeInput,
} from './ports.js';

export interface SettlementCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  attendanceRevision: number;
  totalAmount: string;
  currency: 'RUB';
  roundingMode: RoundingMode;
}

export interface PreviewSettlementResult {
  attendanceRevision: number;
  participantCount: number;
  totalMinor: bigint;
  currency: 'RUB';
  roundingMode: RoundingMode;
  charges: readonly SettlementChargeInput[];
  allocationOrder: readonly string[];
  collectedMinor: bigint;
  surplusMinor: bigint;
}

export class PreviewSettlement {
  public constructor(
    private readonly authorization: PaymentAuthorization,
    private readonly payments: PaymentRepository,
  ) {}

  public async execute(
    command: SettlementCommand,
  ): Promise<PreviewSettlementResult> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const snapshot = await this.payments.findFinalizedAttendance(
      command.groupId,
      command.gameId,
      command.attendanceRevision,
    );
    return calculatePreview(command, requireFinalizedSnapshot(snapshot));
  }
}

export const requireFinalizedSnapshot = (
  snapshot: AttendanceSnapshot | null,
): AttendanceSnapshot => {
  if (snapshot === null || !snapshot.finalized) {
    throw new Error('Finalized attendance revision required');
  }
  return snapshot;
};

export const calculatePreview = (
  command: SettlementCommand,
  snapshot: AttendanceSnapshot,
): PreviewSettlementResult => {
  if (
    snapshot.groupId !== command.groupId ||
    snapshot.gameId !== command.gameId ||
    snapshot.revision !== command.attendanceRevision
  ) {
    throw new Error('Finalized attendance revision required');
  }
  if (command.currency !== 'RUB') {
    throw new Error('Settlement currency must be RUB');
  }
  const billableEntries = snapshot.entries.filter((entry) => entry.billable);
  const total = rubles(command.totalAmount);
  const calculation = calculateSettlement({
    total,
    participantIds: billableEntries.map((entry) => entry.participantRef),
    roundingMode: command.roundingMode,
  });
  const entriesByRef = new Map(
    billableEntries.map((entry) => [entry.participantRef, entry]),
  );
  const charges = calculation.charges.map((charge) => {
    const entry = entriesByRef.get(charge.participantId);
    if (entry === undefined) throw new Error('Attendance entry not found');
    return {
      participantRef: entry.participantRef,
      displayName: entry.displayName,
      addedManually: entry.addedManually,
      amountMinor: charge.amountMinor,
    };
  });
  return {
    attendanceRevision: snapshot.revision,
    participantCount: charges.length,
    totalMinor: total.amountMinor,
    currency: total.currency,
    roundingMode: command.roundingMode,
    charges,
    allocationOrder: charges.map((charge) => charge.participantRef),
    collectedMinor: calculation.collectedMinor,
    surplusMinor: calculation.surplusMinor,
  };
};
