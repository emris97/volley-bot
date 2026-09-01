import type {
  AttendanceSnapshot,
  GameId,
  GroupId,
  RegistrationId,
  UserId,
} from '@volley/domain';
import type { GameAuthorization } from '../games/ports.js';
import type { AttendanceRepository } from './ports.js';

export interface ConfirmAttendanceCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
  excludedRegistrationIds: RegistrationId[];
  manualParticipants: Array<{ displayName: string; billable: boolean }>;
  finalize: boolean;
}

export class ConfirmAttendance {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly attendance: AttendanceRepository,
  ) {}

  public async execute(
    command: ConfirmAttendanceCommand,
  ): Promise<AttendanceSnapshot> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    return this.attendance.confirm(command);
  }
}

export type { AttendanceRepository } from './ports.js';
