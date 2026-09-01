import { Logger } from '@nestjs/common';
import type { DelayedJobScheduler, RequiredJob } from '@volley/application';
import type {
  Game,
  GameId,
  GameState,
  GroupId,
  RegistrationCandidate,
} from '@volley/domain';
import { Queue, Worker } from 'bullmq';
import type { ManagedWorker } from '../worker-lifecycle.service.js';

interface LockedChanges {
  updateState(state: GameState): Promise<Game>;
}

export interface SchedulerGameRepository {
  findById(groupId: GroupId, gameId: GameId): Promise<Game | null>;
  withLockedGame<T>(
    groupId: GroupId,
    gameId: GameId,
    callback: (game: Game, changes: LockedChanges) => Promise<T>,
  ): Promise<T>;
  listForReconciliation(
    limit: number,
    afterId?: GameId,
  ): Promise<readonly Game[]>;
}

export interface SchedulerRegistrationRepository {
  listCandidates(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly RegistrationCandidate[]>;
}

export class GameSchedulerConsumer {
  public constructor(
    private readonly games: Pick<
      SchedulerGameRepository,
      'findById' | 'withLockedGame'
    >,
    private readonly handleNotification: (
      job: RequiredJob,
    ) => Promise<void> = async () => undefined,
  ) {}

  public async process(job: RequiredJob): Promise<void> {
    if (job.expectedState === undefined || job.targetState === undefined) {
      const game = await this.games.findById(job.groupId, job.gameId);
      if (
        game === null ||
        game.scheduleRevision !== job.scheduleRevision ||
        game.state === 'DRAFT' ||
        game.state === 'CANCELLED' ||
        game.state === 'COMPLETED'
      ) {
        return;
      }
      await this.handleNotification(job);
      return;
    }
    await this.games.withLockedGame(
      job.groupId,
      job.gameId,
      async (game, changes) => {
        if (
          game.scheduleRevision !== job.scheduleRevision ||
          game.state !== job.expectedState
        ) {
          return;
        }
        await changes.updateState(job.targetState!);
      },
    );
  }
}

export class BullMqDelayedJobScheduler implements DelayedJobScheduler {
  public constructor(
    private readonly queue: Queue,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async ensure(job: RequiredJob): Promise<void> {
    await this.queue.add(job.kind, job, {
      jobId: job.id,
      delay: Math.max(0, job.runAt.getTime() - this.now().getTime()),
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800 },
    });
  }

  public async remove(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (job !== undefined) await job.remove();
  }
}

export class GameSchedulerRuntime implements ManagedWorker {
  private readonly logger = new Logger(GameSchedulerRuntime.name);
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  public constructor(
    private readonly worker: Worker,
    private readonly reconcile: () => Promise<void>,
    private readonly closeResources: () => Promise<void>,
    private readonly intervalMs = 60_000,
  ) {}

  public async start(): Promise<void> {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error(
        'Game scheduler worker stopped unexpectedly',
        error instanceof Error ? error.stack : String(error),
      );
    });
    await this.reconcileOnce();
    this.timer = setInterval(() => void this.reconcileOnce(), this.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.worker.close();
    await this.closeResources();
  }

  private async reconcileOnce(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(
        'Game job reconciliation failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.reconciling = false;
    }
  }
}
