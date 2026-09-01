import { and, eq } from 'drizzle-orm';
import type { GameId, GameState, GroupId } from '@volley/domain';
import type { Database } from '../client.js';
import {
  scheduledJobs,
  type ScheduledJobKind,
} from '../schema/scheduled-jobs.js';

interface PersistedRequiredJob {
  id: string;
  kind: ScheduledJobKind;
  groupId: GroupId;
  gameId: GameId;
  scheduleRevision: number;
  runAt: Date;
  expectedState?: GameState;
  targetState?: GameState;
}

export class ScheduledJobRepository {
  public constructor(private readonly database: Database) {}

  public async listForGame(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<
    readonly {
      id: string;
      kind: ScheduledJobKind;
      runAt: Date;
      scheduleRevision: number;
      completed: boolean;
    }[]
  > {
    const rows = await this.database
      .select()
      .from(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.groupId, groupId),
          eq(scheduledJobs.gameId, gameId),
        ),
      );
    return rows.map((row) => ({
      id: row.deterministicJobId,
      kind: row.kind,
      runAt: row.runAt,
      scheduleRevision: row.scheduleRevision,
      completed: row.completedAt !== null,
    }));
  }

  public async upsert(job: PersistedRequiredJob): Promise<void> {
    await this.database
      .insert(scheduledJobs)
      .values({
        groupId: job.groupId,
        gameId: job.gameId,
        deterministicJobId: job.id,
        kind: job.kind,
        scheduleRevision: job.scheduleRevision,
        runAt: job.runAt,
        payload: serializeJob(job),
      })
      .onConflictDoUpdate({
        target: [scheduledJobs.gameId, scheduledJobs.deterministicJobId],
        set: {
          kind: job.kind,
          scheduleRevision: job.scheduleRevision,
          runAt: job.runAt,
          payload: serializeJob(job),
          updatedAt: new Date(),
        },
      });
  }

  public async remove(
    groupId: GroupId,
    gameId: GameId,
    id: string,
  ): Promise<void> {
    await this.database
      .delete(scheduledJobs)
      .where(
        and(
          eq(scheduledJobs.groupId, groupId),
          eq(scheduledJobs.gameId, gameId),
          eq(scheduledJobs.deterministicJobId, id),
        ),
      );
  }

  public async markCompleted(
    groupId: GroupId,
    gameId: GameId,
    id: string,
  ): Promise<void> {
    await this.database
      .update(scheduledJobs)
      .set({ completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(scheduledJobs.groupId, groupId),
          eq(scheduledJobs.gameId, gameId),
          eq(scheduledJobs.deterministicJobId, id),
        ),
      );
  }
}

const serializeJob = (job: PersistedRequiredJob): Record<string, unknown> => ({
  groupId: job.groupId,
  gameId: job.gameId,
  scheduleRevision: job.scheduleRevision,
  ...(job.expectedState === undefined
    ? {}
    : { expectedState: job.expectedState }),
  ...(job.targetState === undefined ? {} : { targetState: job.targetState }),
});
