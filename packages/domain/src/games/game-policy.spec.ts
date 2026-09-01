import { describe, expect, it } from 'vitest';
import { createGameFromTemplate, transitionGame } from './game-policy.js';
import type { GameTemplateSnapshot } from './game-template.js';

describe('transitionGame', () => {
  it('allows a scheduled game to open', () => {
    expect(transitionGame('SCHEDULED', 'OPEN')).toBe('OPEN');
  });

  it.each([
    ['COMPLETED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
    ['DRAFT', 'COMPLETED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => transitionGame(from, to)).toThrow(
      /invalid game transition/i,
    );
  });
});

it('copies a template snapshot instead of retaining a mutable reference', () => {
  const template: GameTemplateSnapshot = {
    name: 'Wednesday volleyball',
    venue: 'Central gym',
    address: null,
    startsAtLocalTime: '19:00',
    durationMinutes: 120,
    capacity: 14,
    registrationOpensMinutesBefore: 10_080,
    registrationClosesMinutesBefore: 60,
    tentativePromptMinutesBefore: 1_440,
    tentativeResponseMinutes: 60,
    reminderMinutesBefore: 120,
    memberPriorityEnabled: true,
    defaultTotalCostMinor: null,
    currency: 'RUB',
    roundingMode: 'EXACT',
  };

  const game = createGameFromTemplate(
    template,
    new Date('2026-09-02T15:00:00.000Z'),
    'Europe/Astrakhan',
  );

  template.capacity = 99;

  expect(game.capacity).toBe(14);
  expect(game.startsAt).toEqual(new Date('2026-09-02T15:00:00.000Z'));
  expect(game.timeZone).toBe('Europe/Astrakhan');
});
