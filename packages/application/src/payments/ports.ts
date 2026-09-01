import type {
  AttendanceSnapshot,
  AttendanceSnapshotId,
  GameId,
  GroupId,
  RoundingMode,
  UserId,
} from '@volley/domain';

export type ChargeStatus = 'UNPAID' | 'PAID' | 'WAIVED';

export interface SettlementChargeRecord {
  id: string;
  settlementId: string;
  participantRef: string;
  displayName: string;
  addedManually: boolean;
  amountMinor: bigint;
  status: ChargeStatus;
  createdAt: Date;
}

export interface Settlement {
  id: string;
  groupId: GroupId;
  gameId: GameId;
  attendanceSnapshotId: AttendanceSnapshotId;
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
  charges: readonly SettlementChargeRecord[];
}

export interface SettlementChargeInput {
  participantRef: string;
  displayName: string;
  addedManually: boolean;
  amountMinor: bigint;
}

export interface CreateSettlementRevisionInput {
  actorUserId: UserId;
  totalMinor: bigint;
  currency: 'RUB';
  roundingMode: RoundingMode;
  allocationOrder: readonly string[];
  collectedMinor: bigint;
  surplusMinor: bigint;
  charges: readonly SettlementChargeInput[];
}

export interface LockedSettlementChanges {
  createRevision(input: CreateSettlementRevisionInput): Promise<Settlement>;
}

export interface ChangeChargeStatusInput {
  groupId: GroupId;
  chargeId: string;
  actorUserId: UserId;
  status: ChargeStatus;
}

export interface EnqueuePaymentRemindersInput {
  groupId: GroupId;
  actorUserId: UserId;
  chargeIds: readonly string[];
}

export interface PaymentDraft {
  id: string;
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  attendanceRevision: number;
  totalAmount: string;
  currency: 'RUB';
  roundingMode: RoundingMode;
  expiresAt: Date;
}

export type SavePaymentDraftInput = Omit<PaymentDraft, 'id' | 'expiresAt'>;

export interface PaymentDraftRepository {
  saveDraft(input: SavePaymentDraftInput): Promise<PaymentDraft>;
  findDraft(groupId: GroupId, draftId: string): Promise<PaymentDraft | null>;
  deleteDraft(groupId: GroupId, draftId: string): Promise<void>;
}

export interface PaymentRepository {
  findFinalizedAttendance(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
  ): Promise<AttendanceSnapshot | null>;
  withLockedFinalizedAttendance<T>(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
    callback: (
      snapshot: AttendanceSnapshot,
      changes: LockedSettlementChanges,
    ) => Promise<T>,
  ): Promise<T>;
  changeChargeStatus(
    input: ChangeChargeStatusInput,
  ): Promise<SettlementChargeRecord>;
  enqueueReminders(
    input: EnqueuePaymentRemindersInput,
  ): Promise<{ enqueued: number }>;
}

export interface PaymentAuthorization {
  requireOrganizer(groupId: GroupId, actorUserId: UserId): Promise<void>;
}
