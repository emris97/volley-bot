import type { GameId } from '../games/game.js';
import type { GroupId } from '../identity.js';
import type { RegistrationId } from '../registrations/registration.js';

declare const attendanceSnapshotIdBrand: unique symbol;

export type AttendanceSnapshotId = string & {
  readonly [attendanceSnapshotIdBrand]: 'AttendanceSnapshotId';
};

export const asAttendanceSnapshotId = (value: string): AttendanceSnapshotId =>
  value as AttendanceSnapshotId;

export interface AttendanceEntry {
  participantRef: string;
  sourceRegistrationId?: RegistrationId;
  displayName: string;
  billable: boolean;
  addedManually: boolean;
}

export interface AttendanceRosterCandidate {
  participantRef: string;
  sourceRegistrationId: RegistrationId;
  displayName: string;
  billable: boolean;
  included: boolean;
}

export interface AttendanceSnapshot {
  id: AttendanceSnapshotId;
  groupId: GroupId;
  gameId: GameId;
  revision: number;
  finalized: boolean;
  rosterCandidates: readonly AttendanceRosterCandidate[];
  entries: readonly AttendanceEntry[];
}
