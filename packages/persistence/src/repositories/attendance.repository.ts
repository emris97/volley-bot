import { randomUUID } from 'node:crypto';
import {
  asRegistrationId,
  type AttendanceEntry,
  type AttendanceSnapshot,
  type GameId,
  type GroupId,
  type RegistrationId,
  type UserId,
} from '@volley/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceEntries,
  attendanceSnapshots,
  auditEvents,
  games,
  outboxEvents,
  registrations,
  users,
} from '../schema/index.js';

export class AttendanceRepository {
  public constructor(private readonly database: Database) {}

  public async confirm(
    input: ConfirmAttendanceInput,
  ): Promise<AttendanceSnapshot> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select({ id: games.id, state: games.state })
        .from(games)
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        )
        .for('update')
        .limit(1);
      if (game === undefined) throw new Error('Game not found');
      if (game.state !== 'COMPLETED') throw new Error('Game must be completed');

      const [latest] = await transaction
        .select()
        .from(attendanceSnapshots)
        .where(
          and(
            eq(attendanceSnapshots.groupId, input.groupId),
            eq(attendanceSnapshots.gameId, input.gameId),
          ),
        )
        .orderBy(desc(attendanceSnapshots.revision))
        .limit(1);
      if (latest?.finalized) {
        return readSnapshot(transaction, input.groupId, input.gameId, latest);
      }
      if (latest !== undefined && latest.revision !== input.expectedRevision) {
        return readSnapshot(transaction, input.groupId, input.gameId, latest);
      }
      if (latest === undefined && input.expectedRevision !== 0) {
        throw new Error('Attendance revision is stale');
      }

      const roster = await transaction
        .select({
          id: registrations.id,
          guestDisplayName: registrations.guestDisplayName,
          memberDisplayName: users.displayName,
        })
        .from(registrations)
        .leftJoin(users, eq(users.id, registrations.userId))
        .where(
          and(
            eq(registrations.groupId, input.groupId),
            eq(registrations.gameId, input.gameId),
            eq(registrations.state, 'ROSTERED'),
          ),
        );
      const excluded = new Set(input.excludedRegistrationIds);
      const [snapshot] = await transaction
        .insert(attendanceSnapshots)
        .values({
          groupId: input.groupId,
          gameId: input.gameId,
          revision: input.expectedRevision + 1,
          finalized: input.finalize,
          excludedRegistrationIds: [...excluded],
        })
        .returning();
      if (snapshot === undefined)
        throw new Error('Attendance snapshot insert returned no row');

      const entries = [
        ...roster
          .filter(
            (registration) => !excluded.has(asRegistrationId(registration.id)),
          )
          .map((registration) => ({
            snapshotId: snapshot.id,
            groupId: input.groupId,
            participantRef: `registration:${registration.id}`,
            sourceRegistrationId: registration.id,
            displayName:
              registration.guestDisplayName ??
              registration.memberDisplayName ??
              `Participant ${registration.id}`,
            billable: true,
            addedManually: false,
          })),
        ...input.manualParticipants.map((participant) => ({
          snapshotId: snapshot.id,
          groupId: input.groupId,
          participantRef: `manual:${randomUUID()}`,
          displayName: participant.displayName,
          billable: participant.billable,
          addedManually: true,
        })),
      ];
      if (entries.length > 0)
        await transaction.insert(attendanceEntries).values(entries);
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        eventType: input.finalize
          ? 'ATTENDANCE_CONFIRMED'
          : 'ATTENDANCE_PREVIEWED',
        entityType: 'ATTENDANCE_SNAPSHOT',
        entityId: snapshot.id,
        payload: { revision: snapshot.revision, entryCount: entries.length },
      });
      await transaction.insert(outboxEvents).values({
        groupId: input.groupId,
        eventType: input.finalize
          ? 'ATTENDANCE_CONFIRMED'
          : 'ATTENDANCE_PREVIEWED',
        aggregateType: 'GAME',
        aggregateId: input.gameId,
        payload: { snapshotId: snapshot.id, revision: snapshot.revision },
      });
      return readSnapshot(transaction, input.groupId, input.gameId, snapshot);
    });
  }
}

interface ConfirmAttendanceInput {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
  excludedRegistrationIds: RegistrationId[];
  manualParticipants: Array<{ displayName: string; billable: boolean }>;
  finalize: boolean;
}

const readSnapshot = async (
  database: Database,
  groupId: AttendanceSnapshot['groupId'],
  gameId: AttendanceSnapshot['gameId'],
  snapshot: typeof attendanceSnapshots.$inferSelect,
): Promise<AttendanceSnapshot> => {
  const entries = await database
    .select()
    .from(attendanceEntries)
    .where(
      and(
        eq(attendanceEntries.groupId, groupId),
        eq(attendanceEntries.snapshotId, snapshot.id),
      ),
    );
  const roster = await database
    .select({
      id: registrations.id,
      guestDisplayName: registrations.guestDisplayName,
      memberDisplayName: users.displayName,
    })
    .from(registrations)
    .leftJoin(users, eq(users.id, registrations.userId))
    .where(
      and(
        eq(registrations.groupId, groupId),
        eq(registrations.gameId, gameId),
        eq(registrations.state, 'ROSTERED'),
      ),
    );
  const includedRegistrationIds = new Set(
    entries.flatMap((entry) =>
      entry.sourceRegistrationId === null ? [] : [entry.sourceRegistrationId],
    ),
  );
  return {
    groupId,
    gameId,
    revision: snapshot.revision,
    finalized: snapshot.finalized,
    rosterCandidates: roster.map((registration) => ({
      participantRef: `registration:${registration.id}`,
      sourceRegistrationId: asRegistrationId(registration.id),
      displayName:
        registration.guestDisplayName ??
        registration.memberDisplayName ??
        `Participant ${registration.id}`,
      billable: true,
      included: includedRegistrationIds.has(registration.id),
    })),
    entries: entries.map(toAttendanceEntry),
  };
};

const toAttendanceEntry = (
  entry: typeof attendanceEntries.$inferSelect,
): AttendanceEntry => ({
  participantRef: entry.participantRef,
  ...(entry.sourceRegistrationId === null
    ? {}
    : { sourceRegistrationId: asRegistrationId(entry.sourceRegistrationId) }),
  displayName: entry.displayName,
  billable: entry.billable,
  addedManually: entry.addedManually,
});
