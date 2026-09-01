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

  public async execute(command: SettlementCommand): Promise<Settlement> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    return this.payments.withLockedFinalizedAttendance(
      command.groupId,
      command.gameId,
      command.attendanceRevision,
      async (snapshot, changes) => {
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
      },
    );
  }
}

export type { SettlementCommand as FinalizeSettlementCommand } from './preview-settlement.js';
