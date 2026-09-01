import type { Settlement } from './ports.js';
import type { PaymentAuthorization, PaymentRepository } from './ports.js';
import {
  calculatePreview,
  requireFinalizedSnapshot,
  type SettlementCommand,
} from './preview-settlement.js';

export class FinalizeSettlement {
  public constructor(
    private readonly authorization: PaymentAuthorization,
    private readonly payments: PaymentRepository,
  ) {}

  public async execute(
    command: SettlementCommand & { draftId?: string },
  ): Promise<Settlement> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const finalize = async (
      snapshot: Parameters<
        Parameters<PaymentRepository['withLockedFinalizedAttendance']>[3]
      >[0],
      changes: Parameters<
        Parameters<PaymentRepository['withLockedFinalizedAttendance']>[3]
      >[1],
    ) => {
      const preview = calculatePreview(
        command,
        requireFinalizedSnapshot(snapshot),
      );
      return changes.createRevision({
        actorUserId: command.actorUserId,
        totalMinor: preview.totalMinor,
        currency: preview.currency,
        roundingMode: preview.roundingMode,
        allocationOrder: preview.allocationOrder,
        collectedMinor: preview.collectedMinor,
        surplusMinor: preview.surplusMinor,
        charges: preview.charges,
      });
    };
    return command.draftId === undefined
      ? this.payments.withLockedFinalizedAttendance(
          command.groupId,
          command.gameId,
          command.attendanceRevision,
          finalize,
        )
      : this.payments.finalizeDraft(
          {
            groupId: command.groupId,
            gameId: command.gameId,
            attendanceRevision: command.attendanceRevision,
            draftId: command.draftId,
            actorUserId: command.actorUserId,
          },
          finalize,
        );
  }
}

export type { SettlementCommand as FinalizeSettlementCommand } from './preview-settlement.js';
