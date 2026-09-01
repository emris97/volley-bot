import type {
  AttendanceSnapshot,
  AttendanceSnapshotId,
  GameId,
  GroupId,
  RoundingMode,
  TelegramId,
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
  finalizedSettlementId: string | null;
}

export type SavePaymentDraftInput = Omit<
  PaymentDraft,
  'id' | 'expiresAt' | 'finalizedSettlementId'
>;

export interface PaymentDraftRepository {
  saveDraft(input: SavePaymentDraftInput): Promise<PaymentDraft>;
  findDraft(groupId: GroupId, draftId: string): Promise<PaymentDraft | null>;
  deleteDraft(groupId: GroupId, draftId: string): Promise<void>;
}

export interface PaymentInputSession {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  attendanceRevision: number;
  currency: 'RUB';
  roundingMode: RoundingMode;
  expiresAt: Date;
}

export interface PaymentInputRepository {
  beginInput(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
  }): Promise<PaymentInputSession>;
  findInputByTelegramUserId(
    telegramUserId: TelegramId,
  ): Promise<PaymentInputSession | null>;
  clearInput(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

export interface ActiveSettlementReader {
  findActiveSettlement(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<Settlement | null>;
}

export interface PaymentTelegramRepository
  extends
    PaymentDraftRepository,
    PaymentInputRepository,
    ActiveSettlementReader {}

export interface PaymentRepository {
  findFinalizedAttendance(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
  ): Promise<AttendanceSnapshot | null>;
  withLockedFinalizedAttendance(
    groupId: GroupId,
    gameId: GameId,
    attendanceRevision: number,
    callback: (
      snapshot: AttendanceSnapshot,
      changes: LockedSettlementChanges,
    ) => Promise<Settlement>,
  ): Promise<Settlement>;
  finalizeDraft(
    input: {
      groupId: GroupId;
      gameId: GameId;
      attendanceRevision: number;
      draftId: string;
      actorUserId: UserId;
    },
    callback: (
      snapshot: AttendanceSnapshot,
      changes: LockedSettlementChanges,
    ) => Promise<Settlement>,
  ): Promise<Settlement>;
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
