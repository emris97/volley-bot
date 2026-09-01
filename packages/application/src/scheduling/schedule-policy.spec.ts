import { describe, expect, it } from 'vitest';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  type Game,
  type RegistrationCandidate,
} from '@volley/domain';
import { requiredJobsForGame } from './schedule-policy.js';

describe('requiredJobsForGame', () => {
  it('does not schedule jobs for a cancelled game', () => {
    expect(
      requiredJobsForGame({ ...game(), state: 'CANCELLED' }, registrations()),
    ).toEqual([]);
  });

  it('changes all time-based job ids when the schedule revision changes', () => {
    const before = requiredJobsForGame(
      { ...game(), scheduleRevision: 1 },
      registrations(),
    );
    const after = requiredJobsForGame(
      { ...game(), scheduleRevision: 2 },
      registrations(),
    );

    expect(after.map((job) => job.id)).not.toEqual(before.map((job) => job.id));
    expect(after.every((job) => job.id.endsWith(':2'))).toBe(true);
  });

  it('schedules only registration-dependent notifications that have recipients', () => {
    const jobs = requiredJobsForGame(game(), registrations());

    expect(jobs.map((job) => job.kind)).toEqual([
      'OPEN_REGISTRATION',
      'CLOSE_REGISTRATION',
      'REQUEST_TENTATIVE_CONFIRMATION',
      'EXPIRE_TENTATIVE',
      'REMIND_PARTICIPANTS',
    ]);
    expect(requiredJobsForGame(game(), []).map((job) => job.kind)).toEqual([
      'OPEN_REGISTRATION',
      'CLOSE_REGISTRATION',
    ]);
  });
});

const game = (): Game => ({
  id: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  sourceTemplateId: null,
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-04T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-08-28T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-04T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-09-03T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-03T17:00:00.000Z'),
  reminderAt: new Date('2026-09-04T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'SCHEDULED',
  scheduleRevision: 1,
  canonicalTelegramMessageId: null,
});

const registrations = (): RegistrationCandidate[] => [
  {
    id: asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424620'),
    kind: 'MEMBER',
    state: 'TENTATIVE',
    manualRank: null,
    membershipPriority: 1,
    confirmedAt: null,
  },
  {
    id: asRegistrationId('018f6ba0-62d2-7bd1-8f13-12e0c8424621'),
    kind: 'MEMBER',
    state: 'ROSTERED',
    manualRank: null,
    membershipPriority: 1,
    confirmedAt: new Date('2026-08-30T10:00:00.000Z'),
  },
];
