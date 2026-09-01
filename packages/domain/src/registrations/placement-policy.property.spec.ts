import fc from 'fast-check';
import { expect, it } from 'vitest';
import { asRegistrationId, type RegistrationCandidate } from './registration.js';
import { placeConfirmedRegistrations } from './placement-policy.js';

const candidateArbitrary = fc
  .record({
    id: fc.uuid(),
    kind: fc.constantFrom<'MEMBER' | 'GUEST'>('MEMBER', 'GUEST'),
    state: fc.constantFrom<'TENTATIVE' | 'ROSTERED' | 'WAITLISTED' | 'CANCELLED'>(
      'TENTATIVE',
      'ROSTERED',
      'WAITLISTED',
      'CANCELLED',
    ),
    manualRank: fc.option(fc.integer({ min: 0, max: 100 }), { nil: null }),
    confirmedAtMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  })
  .map(
    (value): RegistrationCandidate => ({
      id: asRegistrationId(value.id),
      kind: value.kind,
      state: value.state,
      manualRank: value.manualRank,
      membershipPriority: value.kind === 'MEMBER' ? 1 : 0,
      confirmedAt:
        value.state === 'TENTATIVE' ? null : new Date(value.confirmedAtMs),
    }),
  );

it('never exceeds capacity or places inactive registrations', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(candidateArbitrary, { selector: (item) => item.id }),
      fc.integer({ min: 1, max: 30 }),
      (registrations, capacity) => {
        const result = placeConfirmedRegistrations({
          capacity,
          registrations,
        });
        expect(result.roster.length).toBeLessThanOrEqual(capacity);
        expect(
          result.roster.every(
            (item) =>
              item.state !== 'TENTATIVE' && item.state !== 'CANCELLED',
          ),
        ).toBe(true);
      },
    ),
  );
});

it('returns the same order for every permutation of the same candidates', () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(candidateArbitrary, {
        minLength: 1,
        maxLength: 30,
        selector: (item) => item.id,
      }),
      fc.integer({ min: 1, max: 30 }),
      (registrations, capacity) => {
        const reversed = [...registrations].reverse();
        const ids = (items: readonly RegistrationCandidate[]) =>
          items.map((item) => item.id);
        const first = placeConfirmedRegistrations({ capacity, registrations });
        const second = placeConfirmedRegistrations({
          capacity,
          registrations: reversed,
        });
        expect(ids(second.roster)).toEqual(ids(first.roster));
        expect(ids(second.waitlist)).toEqual(ids(first.waitlist));
      },
    ),
  );
});
