import { describe, expect, it } from 'vitest';
import { asRegistrationId, type RegistrationCandidate } from './registration.js';
import { placeConfirmedRegistrations } from './placement-policy.js';

const candidate = (
  id: string,
  kind: 'MEMBER' | 'GUEST',
  confirmedAt: string,
  overrides: Partial<RegistrationCandidate> = {},
): RegistrationCandidate => ({
  id: asRegistrationId(id),
  kind,
  state: 'ROSTERED',
  manualRank: null,
  membershipPriority: kind === 'MEMBER' ? 1 : 0,
  confirmedAt: new Date(confirmedAt),
  ...overrides,
});

describe('placeConfirmedRegistrations', () => {
  it('places members before earlier guests', () => {
    const placed = placeConfirmedRegistrations({
      capacity: 1,
      registrations: [
        candidate('guest', 'GUEST', '2026-09-01T09:00:00.000Z'),
        candidate('member', 'MEMBER', '2026-09-01T09:01:00.000Z'),
      ],
    });
    expect(placed.roster.map((item) => item.kind)).toEqual(['MEMBER']);
    expect(placed.waitlist.map((item) => item.kind)).toEqual(['GUEST']);
  });

  it('places an explicit administrator rank before automatic priority', () => {
    const placed = placeConfirmedRegistrations({
      capacity: 1,
      registrations: [
        candidate('member', 'MEMBER', '2026-09-01T09:00:00.000Z'),
        candidate('guest', 'GUEST', '2026-09-01T09:01:00.000Z', {
          manualRank: 0,
        }),
      ],
    });
    expect(placed.roster[0]?.id).toBe(asRegistrationId('guest'));
  });

  it('uses confirmation time and stable id as deterministic tie-breakers', () => {
    const placed = placeConfirmedRegistrations({
      capacity: 3,
      registrations: [
        candidate('c', 'MEMBER', '2026-09-01T09:01:00.000Z'),
        candidate('b', 'MEMBER', '2026-09-01T09:00:00.000Z'),
        candidate('a', 'MEMBER', '2026-09-01T09:00:00.000Z'),
      ],
    });
    expect(placed.roster.map((item) => item.id)).toEqual([
      asRegistrationId('a'),
      asRegistrationId('b'),
      asRegistrationId('c'),
    ]);
  });

  it('never lets tentative or cancelled registrations consume capacity', () => {
    const placed = placeConfirmedRegistrations({
      capacity: 1,
      registrations: [
        candidate('tentative', 'MEMBER', '2026-09-01T09:00:00.000Z', {
          state: 'TENTATIVE',
          confirmedAt: null,
        }),
        candidate('cancelled', 'MEMBER', '2026-09-01T09:00:00.000Z', {
          state: 'CANCELLED',
        }),
        candidate('confirmed', 'GUEST', '2026-09-01T09:01:00.000Z'),
      ],
    });
    expect(placed.roster.map((item) => item.id)).toEqual([
      asRegistrationId('confirmed'),
    ]);
    expect(placed.waitlist).toEqual([]);
  });

  it('moves the first waiter into the roster when capacity grows', () => {
    const registrations = [
      candidate('first', 'MEMBER', '2026-09-01T09:00:00.000Z'),
      candidate('second', 'MEMBER', '2026-09-01T09:01:00.000Z'),
    ];
    const before = placeConfirmedRegistrations({ capacity: 1, registrations });
    const after = placeConfirmedRegistrations({ capacity: 2, registrations });
    expect(before.waitlist[0]?.id).toBe(asRegistrationId('second'));
    expect(after.roster[1]?.id).toBe(asRegistrationId('second'));
  });
});
