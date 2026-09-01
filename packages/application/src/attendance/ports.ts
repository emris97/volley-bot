import type {
  AttendanceSnapshot,
  AttendanceSnapshotId,
  GroupId,
} from '@volley/domain';
import type { ConfirmAttendanceCommand } from './confirm-attendance.js';

export interface AttendanceRepository {
  confirm(input: ConfirmAttendanceCommand): Promise<AttendanceSnapshot>;
}

export interface AttendanceSnapshotReader {
  findSnapshot(
    groupId: GroupId,
    snapshotId: AttendanceSnapshotId,
  ): Promise<AttendanceSnapshot | null>;
}
