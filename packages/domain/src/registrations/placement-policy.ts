import { InvalidRegistrationError } from './registration-errors.js';
import type { RegistrationCandidate } from './registration.js';

export interface PlacementInput {
  capacity: number;
  registrations: readonly RegistrationCandidate[];
}

export interface PlacementResult {
  roster: RegistrationCandidate[];
  waitlist: RegistrationCandidate[];
}

const compareNullableNumber = (
  left: number | null,
  right: number | null,
): number => {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

const confirmedTime = (candidate: RegistrationCandidate): number => {
  if (candidate.confirmedAt === null) {
    throw new InvalidRegistrationError(
      `Confirmed registration ${candidate.id} has no confirmation time`,
    );
  }
  return candidate.confirmedAt.getTime();
};

const compare = (
  left: RegistrationCandidate,
  right: RegistrationCandidate,
): number =>
  compareNullableNumber(left.manualRank, right.manualRank) ||
  right.membershipPriority - left.membershipPriority ||
  confirmedTime(left) - confirmedTime(right) ||
  left.id.localeCompare(right.id);

export const rankConfirmedRegistrations = (
  registrations: readonly RegistrationCandidate[],
): RegistrationCandidate[] =>
  registrations
    .filter((item) => item.state !== 'TENTATIVE' && item.state !== 'CANCELLED')
    .toSorted(compare);

export const placeConfirmedRegistrations = (
  input: PlacementInput,
): PlacementResult => {
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 0) {
    throw new InvalidRegistrationError(
      'Registration capacity must be a non-negative integer',
    );
  }
  const ranked = rankConfirmedRegistrations(input.registrations);
  return {
    roster: ranked.slice(0, input.capacity),
    waitlist: ranked.slice(input.capacity),
  };
};
