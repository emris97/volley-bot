import { describe, expect, it } from 'vitest';
import { rubles } from './money.js';
import { calculateSettlement } from './settlement.js';

describe('calculateSettlement', () => {
  it('distributes an exact minor-unit remainder deterministically', () => {
    const result = calculateSettlement({
      total: rubles('2800.00'),
      participantIds: ['a', 'b', 'c'],
      roundingMode: 'EXACT',
    });

    expect(result.charges.map((charge) => charge.amountMinor)).toEqual([
      93334n,
      93333n,
      93333n,
    ]);
    expect(result.charges.map((charge) => charge.participantId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(result.collectedMinor).toBe(280000n);
    expect(result.surplusMinor).toBe(0n);
  });

  it('reports surplus when every charge is rounded upward', () => {
    const result = calculateSettlement({
      total: rubles('2800.00'),
      participantIds: Array.from({ length: 18 }, (_, index) => String(index)),
      roundingMode: 'UP_10',
    });

    expect(
      result.charges.every((charge) => charge.amountMinor === 16000n),
    ).toBe(true);
    expect(result.collectedMinor).toBe(288000n);
    expect(result.surplusMinor).toBe(8000n);
  });

  it('rounds a ceiling share upward for tiny positive totals', () => {
    const result = calculateSettlement({
      total: rubles('0.01'),
      participantIds: ['a', 'b', 'c'],
      roundingMode: 'UP_10',
    });

    expect(result.charges.map((charge) => charge.amountMinor)).toEqual([
      1000n,
      1000n,
      1000n,
    ]);
    expect(result.surplusMinor).toBe(2999n);
  });

  it('sorts participant ids before allocating the exact remainder', () => {
    const first = calculateSettlement({
      total: rubles('0.05'),
      participantIds: ['z', 'a', 'm'],
      roundingMode: 'EXACT',
    });
    const second = calculateSettlement({
      total: rubles('0.05'),
      participantIds: ['m', 'z', 'a'],
      roundingMode: 'EXACT',
    });

    expect(second).toEqual(first);
    expect(first.charges).toEqual([
      { participantId: 'a', amountMinor: 2n },
      { participantId: 'm', amountMinor: 2n },
      { participantId: 'z', amountMinor: 1n },
    ]);
  });

  it('rejects an empty participant list', () => {
    expect(() =>
      calculateSettlement({
        total: rubles('10.00'),
        participantIds: [],
        roundingMode: 'EXACT',
      }),
    ).toThrow('At least one participant is required');
  });

  it('rejects duplicate participant ids', () => {
    expect(() =>
      calculateSettlement({
        total: rubles('10.00'),
        participantIds: ['a', 'a'],
        roundingMode: 'EXACT',
      }),
    ).toThrow(/unique/i);
  });
});

describe('rubles', () => {
  it('parses decimal text into integer minor units', () => {
    expect(rubles('2800').amountMinor).toBe(280000n);
    expect(rubles('2800.5').amountMinor).toBe(280050n);
    expect(rubles('2800.00')).toEqual({
      amountMinor: 280000n,
      currency: 'RUB',
    });
  });

  it.each(['1.234', 'abc', '-1.00', '', '1.', '.50'])(
    '%s is invalid money text',
    (value) => {
      expect(() => rubles(value)).toThrow();
    },
  );

  it('accepts only string input at runtime', () => {
    expect(() => rubles(100 as never)).toThrow(/string/i);
  });
});
