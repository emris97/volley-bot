import type { GameTemplateSnapshot } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { TemplateInputError } from './template-errors.js';
import { validateTemplateSnapshot } from './template-validation.js';

const validTemplate: GameTemplateSnapshot = {
  name: 'Friday volleyball',
  venue: 'Arena',
  address: 'Sports street 1',
  startsAtLocalTime: '19:30',
  durationMinutes: 120,
  capacity: 12,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: 125_050n,
  currency: 'RUB',
  roundingMode: 'EXACT',
};

describe('validateTemplateSnapshot', () => {
  it('trims textual fields and turns a blank optional address into null', () => {
    expect(
      validateTemplateSnapshot({
        ...validTemplate,
        name: '  Friday volleyball  ',
        venue: '  Arena  ',
        address: '   ',
      }),
    ).toEqual({
      ...validTemplate,
      name: 'Friday volleyball',
      venue: 'Arena',
      address: null,
    });
  });

  it.each([
    ['name', '', 'NAME'],
    ['name', 'x'.repeat(81), 'NAME'],
    ['venue', '', 'VENUE'],
    ['venue', 'x'.repeat(121), 'VENUE'],
    ['address', 'x'.repeat(301), 'ADDRESS'],
  ] as const)(
    'rejects the exact text boundary for %s',
    (field, value, code) => {
      expect(() =>
        validateTemplateSnapshot({ ...validTemplate, [field]: value }),
      ).toThrow(new TemplateInputError(code));
    },
  );

  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(
      validateTemplateSnapshot({ ...validTemplate, name: '😀'.repeat(80) })
        .name,
    ).toHaveLength(160);
    expect(() =>
      validateTemplateSnapshot({ ...validTemplate, name: '😀'.repeat(81) }),
    ).toThrow(new TemplateInputError('NAME'));
  });

  it('accepts every inclusive numeric boundary', () => {
    expect(
      validateTemplateSnapshot({
        ...validTemplate,
        durationMinutes: 15,
        capacity: 1,
        defaultTotalCostMinor: 0n,
      }),
    ).toMatchObject({ durationMinutes: 15, capacity: 1 });
    expect(
      validateTemplateSnapshot({
        ...validTemplate,
        durationMinutes: 720,
        capacity: 200,
        defaultTotalCostMinor: 100_000_000n,
      }),
    ).toMatchObject({ durationMinutes: 720, capacity: 200 });
  });

  it('accepts the PostgreSQL integer maximum for every offset', () => {
    const maximum = 2_147_483_647;
    expect(
      validateTemplateSnapshot({
        ...validTemplate,
        registrationOpensMinutesBefore: maximum,
        registrationClosesMinutesBefore: maximum,
        tentativePromptMinutesBefore: maximum,
        tentativeResponseMinutes: maximum,
        reminderMinutesBefore: maximum,
      }),
    ).toMatchObject({
      registrationOpensMinutesBefore: maximum,
      registrationClosesMinutesBefore: maximum,
      tentativePromptMinutesBefore: maximum,
      tentativeResponseMinutes: maximum,
      reminderMinutesBefore: maximum,
    });
  });

  it.each([
    ['durationMinutes', 14, 'DURATION'],
    ['durationMinutes', 721, 'DURATION'],
    ['capacity', 0, 'CAPACITY'],
    ['capacity', 201, 'CAPACITY'],
    ['defaultTotalCostMinor', -1n, 'COST'],
    ['defaultTotalCostMinor', 100_000_001n, 'COST'],
  ] as const)('rejects invalid bounded value %s=%s', (field, value, code) => {
    expect(() =>
      validateTemplateSnapshot({ ...validTemplate, [field]: value }),
    ).toThrow(new TemplateInputError(code));
  });

  it.each([
    ['startsAtLocalTime', '24:00', 'TIME'],
    ['registrationOpensMinutesBefore', -1, 'OPENING'],
    ['registrationClosesMinutesBefore', -1, 'CLOSING'],
    ['tentativePromptMinutesBefore', -1, 'CONFIRMATION'],
    ['tentativeResponseMinutes', -1, 'CONFIRMATION'],
    ['reminderMinutesBefore', -1, 'REMINDER'],
    ['reminderMinutesBefore', Number.MAX_SAFE_INTEGER + 1, 'REMINDER'],
  ] as const)(
    'rejects invalid scheduling value %s=%s',
    (field, value, code) => {
      expect(() =>
        validateTemplateSnapshot({ ...validTemplate, [field]: value }),
      ).toThrow(new TemplateInputError(code));
    },
  );

  it.each([
    ['registrationOpensMinutesBefore', 'OPENING'],
    ['registrationClosesMinutesBefore', 'CLOSING'],
    ['tentativePromptMinutesBefore', 'CONFIRMATION'],
    ['tentativeResponseMinutes', 'CONFIRMATION'],
    ['reminderMinutesBefore', 'REMINDER'],
  ] as const)('rejects PostgreSQL integer overflow for %s', (field, code) => {
    expect(() =>
      validateTemplateSnapshot({
        ...validTemplate,
        [field]: 2_147_483_648,
      }),
    ).toThrow(new TemplateInputError(code));
  });

  it('rejects timing that would violate a game time-order constraint', () => {
    expect(() =>
      validateTemplateSnapshot({
        ...validTemplate,
        registrationOpensMinutesBefore: 30,
        registrationClosesMinutesBefore: 60,
      }),
    ).toThrow(new TemplateInputError('CLOSING'));
    expect(() =>
      validateTemplateSnapshot({
        ...validTemplate,
        tentativePromptMinutesBefore: 30,
        tentativeResponseMinutes: 60,
      }),
    ).toThrow(new TemplateInputError('CONFIRMATION'));
  });
});
