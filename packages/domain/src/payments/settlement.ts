import type { RoundingMode } from '../games/game-template.js';
import type { Money } from './money.js';

export class StalePaymentDraftError extends Error {
  public constructor(message = 'Payment preview is stale') {
    super(message);
    this.name = 'StalePaymentDraftError';
  }
}

export type { RoundingMode } from '../games/game-template.js';

export interface SettlementInput {
  readonly total: Money;
  readonly participantIds: readonly string[];
  readonly roundingMode: RoundingMode;
}

export interface SettlementCharge {
  readonly participantId: string;
  readonly amountMinor: bigint;
}

export interface SettlementCalculation {
  readonly charges: SettlementCharge[];
  readonly collectedMinor: bigint;
  readonly surplusMinor: bigint;
}

const stepMinor = (roundingMode: RoundingMode): bigint => {
  switch (roundingMode) {
    case 'UP_1':
      return 100n;
    case 'UP_10':
      return 1_000n;
    case 'UP_50':
      return 5_000n;
    case 'EXACT':
      return 1n;
    default:
      throw new Error(`Unsupported rounding mode: ${String(roundingMode)}`);
  }
};

const roundUp = (amountMinor: bigint, step: bigint): bigint =>
  ((amountMinor + step - 1n) / step) * step;

const assertUniqueParticipantIds = (orderedIds: readonly string[]): void => {
  for (let index = 1; index < orderedIds.length; index += 1) {
    if (orderedIds[index] === orderedIds[index - 1]) {
      throw new Error('Participant ids must be unique');
    }
  }
};

export function calculateSettlement(
  input: SettlementInput,
): SettlementCalculation {
  if (input.participantIds.length === 0) {
    throw new Error('At least one participant is required');
  }
  if (input.total.currency !== 'RUB') {
    throw new Error('Settlement total must be in RUB');
  }
  if (input.total.amountMinor < 0n) {
    throw new Error('Settlement total cannot be negative');
  }

  const orderedIds = input.participantIds.toSorted();
  assertUniqueParticipantIds(orderedIds);

  const count = BigInt(orderedIds.length);
  const totalMinor = input.total.amountMinor;
  const charges =
    input.roundingMode === 'EXACT'
      ? (() => {
          const base = totalMinor / count;
          const remainder = totalMinor % count;
          return orderedIds.map((participantId, index) => ({
            participantId,
            amountMinor: base + (BigInt(index) < remainder ? 1n : 0n),
          }));
        })()
      : (() => {
          // Ceiling before step rounding keeps every upward mode nonnegative
          // even when the total is smaller than the participant count.
          const share = (totalMinor + count - 1n) / count;
          const amountMinor = roundUp(share, stepMinor(input.roundingMode));
          return orderedIds.map((participantId) => ({
            participantId,
            amountMinor,
          }));
        })();

  const collectedMinor = charges.reduce(
    (sum, charge) => sum + charge.amountMinor,
    0n,
  );
  return {
    charges,
    collectedMinor,
    surplusMinor: collectedMinor - totalMinor,
  };
}
