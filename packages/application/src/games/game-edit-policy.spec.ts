import type { GameState } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  editableFields,
  normalizeGameChanges,
  type GameEditableField,
} from './game-edit-policy.js';

const everyField: readonly GameEditableField[] = [
  'name',
  'venue',
  'address',
  'startsAt',
  'durationMinutes',
  'capacity',
  'registrationOpensAt',
  'registrationClosesAt',
  'tentativePromptAt',
  'tentativeResponseDeadline',
  'reminderAt',
  'memberPriorityEnabled',
  'totalCostMinor',
  'currency',
  'roundingMode',
];

describe('editableFields', () => {
  it.each(['DRAFT', 'SCHEDULED'] satisfies GameState[])(
    'allows every snapshot field in %s',
    (state) => {
      expect(editableFields({ state, registrationCount: 0 })).toEqual(
        everyField,
      );
    },
  );

  it('locks opening and priority in OPEN after the first registration', () => {
    expect(editableFields({ state: 'OPEN', registrationCount: 0 })).toEqual(
      everyField,
    );
    expect(editableFields({ state: 'OPEN', registrationCount: 1 })).toEqual([
      'name',
      'venue',
      'address',
      'startsAt',
      'durationMinutes',
      'capacity',
      'registrationClosesAt',
      'tentativePromptAt',
      'tentativeResponseDeadline',
      'reminderAt',
      'totalCostMinor',
      'currency',
      'roundingMode',
    ]);
  });

  it('allows only identity, place, schedule, capacity, and cost in CLOSED', () => {
    expect(editableFields({ state: 'CLOSED', registrationCount: 14 })).toEqual([
      'name',
      'venue',
      'address',
      'startsAt',
      'durationMinutes',
      'capacity',
      'totalCostMinor',
      'currency',
      'roundingMode',
    ]);
  });

  it.each(['COMPLETED', 'CANCELLED'] satisfies GameState[])(
    'makes %s read-only',
    (state) => {
      expect(editableFields({ state, registrationCount: 14 })).toEqual([]);
    },
  );
});

describe('normalizeGameChanges', () => {
  it('normalizes editable text without changing typed values', () => {
    expect(
      normalizeGameChanges(
        {
          name: '  Evening game  ',
          venue: '  Arena  ',
          address: '   ',
          capacity: 20,
          totalCostMinor: 12_345n,
        },
        new Date('2026-09-06T00:00:00.000Z'),
      ),
    ).toEqual({
      name: 'Evening game',
      venue: 'Arena',
      address: null,
      capacity: 20,
      totalCostMinor: 12_345n,
    });
  });

  it('omits undefined optional changes from the normalized snapshot', () => {
    const normalized = normalizeGameChanges({
      capacity: undefined,
      registrationClosesAt: undefined,
    });

    expect(Object.keys(normalized)).toEqual([]);
  });

  it('rejects changing the start to the present or past', () => {
    expect(() =>
      normalizeGameChanges(
        { startsAt: new Date('2026-09-06T00:00:00.000Z') },
        new Date('2026-09-06T00:00:00.000Z'),
      ),
    ).toThrow('Время начала игры должно быть в будущем.');
  });
});
