import type {
  Game,
  GameId,
  GroupId,
  RegistrationCandidate,
} from '@volley/domain';
import {
  requiredJobsForGame,
  type RequiredJob,
  type ScheduledJobKind,
} from './schedule-policy.js';

export interface StoredScheduledJob {
  id: string;
  kind: ScheduledJobKind;
  runAt: Date;
  scheduleRevision: number;
  completed: boolean;
}

export interface ScheduledJobStore {
  listForGame(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly StoredScheduledJob[]>;
  upsert(job: RequiredJob): Promise<void>;
  remove(groupId: GroupId, gameId: GameId, id: string): Promise<void>;
}

export interface DelayedJobScheduler {
  ensure(job: RequiredJob): Promise<void>;
  remove(id: string): Promise<void>;
}

export class ReconcileGameJobs {
  public constructor(
    private readonly store: ScheduledJobStore,
    private readonly scheduler: DelayedJobScheduler,
  ) {}

  public async execute(
    game: Game,
    registrations: readonly RegistrationCandidate[],
  ): Promise<{ desired: number; removed: number }> {
    if (game.id === undefined || game.groupId === undefined) {
      throw new Error('Persisted game identity is required for reconciliation');
    }
    const desired = requiredJobsForGame(game, registrations);
    const desiredIds = new Set(desired.map((job) => job.id));
    const existing = await this.store.listForGame(game.groupId, game.id);
    const existingById = new Map(existing.map((job) => [job.id, job]));

    for (const job of desired) {
      if (existingById.get(job.id)?.completed === true) continue;
      await this.store.upsert(job);
      await this.scheduler.ensure(job);
    }

    const obsolete = existing.filter((job) => !desiredIds.has(job.id));
    for (const job of obsolete) {
      await this.scheduler.remove(job.id);
      await this.store.remove(game.groupId, game.id, job.id);
    }
    return { desired: desired.length, removed: obsolete.length };
  }
}
