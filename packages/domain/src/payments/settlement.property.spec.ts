import fc from 'fast-check';
import { expect, it } from 'vitest';
import { rubles } from './money.js';
import { calculateSettlement } from './settlement.js';

const participantIdsArbitrary = fc
  .uniqueArray(fc.stringMatching(/[a-z][a-z0-9]{0,5}/), {
    minLength: 1,
    maxLength: 30,
  })
  .filter((ids) => ids.length > 0);

const rublesFromMinor = (amountMinor: bigint) => {
  const whole = amountMinor / 100n;
  const fractional = (amountMinor % 100n).toString().padStart(2, '0');
  return rubles(`${whole}.${fractional}`);
};

const totalArbitrary = fc
  .bigInt({ min: 0n, max: 1_000_000n })
  .map(rublesFromMinor);

const positiveTotalArbitrary = fc
  .bigInt({ min: 1n, max: 1_000_000n })
  .map(rublesFromMinor);

const roundingModeArbitrary = fc.constantFrom<
  'EXACT' | 'UP_1' | 'UP_10' | 'UP_50'
>('EXACT', 'UP_1', 'UP_10', 'UP_50');

it('EXACT charges always sum to the total', () => {
  fc.assert(
    fc.property(
      participantIdsArbitrary,
      totalArbitrary,
      (participantIds, total) => {
        const result = calculateSettlement({
          total,
          participantIds,
          roundingMode: 'EXACT',
        });

        expect(result.collectedMinor).toBe(total.amountMinor);
        expect(result.surplusMinor).toBe(0n);
        expect(
          result.charges.reduce((sum, charge) => sum + charge.amountMinor, 0n),
        ).toBe(total.amountMinor);
      },
    ),
  );
});

it('upward modes produce equal charges and never collect less than the total', () => {
  fc.assert(
    fc.property(
      participantIdsArbitrary,
      totalArbitrary,
      fc.constantFrom<'UP_1' | 'UP_10' | 'UP_50'>('UP_1', 'UP_10', 'UP_50'),
      (participantIds, total, roundingMode) => {
        const result = calculateSettlement({
          total,
          participantIds,
          roundingMode,
        });
        const amounts = result.charges.map((charge) => charge.amountMinor);

        expect(new Set(amounts).size).toBe(1);
        expect(result.collectedMinor).toBeGreaterThanOrEqual(total.amountMinor);
        expect(result.surplusMinor).toBeGreaterThanOrEqual(0n);
      },
    ),
  );
});

it('settlement output is independent of participant input order', () => {
  fc.assert(
    fc.property(
      participantIdsArbitrary,
      totalArbitrary,
      fc.constantFrom<'EXACT' | 'UP_1' | 'UP_10' | 'UP_50'>(
        'EXACT',
        'UP_1',
        'UP_10',
        'UP_50',
      ),
      (participantIds, total, roundingMode) => {
        const shuffled = [...participantIds].reverse();
        expect(
          calculateSettlement({
            total,
            participantIds: shuffled,
            roundingMode,
          }),
        ).toEqual(calculateSettlement({ total, participantIds, roundingMode }));
      },
    ),
  );
});

it('settlement uses bigint monetary values throughout its result', () => {
  fc.assert(
    fc.property(
      participantIdsArbitrary,
      totalArbitrary,
      (participantIds, total) => {
        const result = calculateSettlement({
          total,
          participantIds,
          roundingMode: 'EXACT',
        });

        expect(typeof total.amountMinor).toBe('bigint');
        expect(typeof result.collectedMinor).toBe('bigint');
        expect(typeof result.surplusMinor).toBe('bigint');
        expect(
          result.charges.every(
            (charge) => typeof charge.amountMinor === 'bigint',
          ),
        ).toBe(true);
      },
    ),
  );
});

it('rejects zero participants for every valid positive total and rounding mode', () => {
  fc.assert(
    fc.property(
      positiveTotalArbitrary,
      roundingModeArbitrary,
      (total, roundingMode) => {
        expect(() =>
          calculateSettlement({
            total,
            participantIds: [],
            roundingMode,
          }),
        ).toThrow('At least one participant is required');
      },
    ),
  );
});
