import type { AttendanceSnapshot } from '@volley/domain';
import type { ConfirmAttendanceCommand } from './confirm-attendance.js';

export interface AttendanceRepository {
  confirm(input: ConfirmAttendanceCommand): Promise<AttendanceSnapshot>;
}
