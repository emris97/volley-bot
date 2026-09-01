import type { GameId } from '../games/game.js';
import type { GroupId } from '../identity.js';
import type { RegistrationId } from '../registrations/registration.js';

export interface AttendanceEntry {
  participantRef: string;
  sourceRegistrationId?: RegistrationId;
  displayName: string;
  billable: boolean;
  addedManually: boolean;
}

export interface AttendanceSnapshot {
  groupId: GroupId;
  gameId: GameId;
  revision: number;
  finalized: boolean;
  entries: readonly AttendanceEntry[];
}
