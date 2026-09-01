import { Module } from '@nestjs/common';
import { ReconcileGameJobs, type RequiredJob } from '@volley/application';
import { parseEnv } from '@volley/config';
import type { GameId } from '@volley/domain';
import {
  createDatabase,
  GameRepository,
  RegistrationRepository,
  ScheduledJobRepository,
} from '@volley/persistence';
import { Queue, Worker } from 'bullmq';
import { Pool } from 'pg';
import {
  BullMqDelayedJobScheduler,
  GameSchedulerConsumer,
  GameSchedulerRuntime,
} from './game-scheduler.consumer.js';

export const GAME_SCHEDULER_WORKER = Symbol('GAME_SCHEDULER_WORKER');

@Module({
  providers: [
    {
      provide: GAME_SCHEDULER_WORKER,
      useFactory: () => {
        const env = parseEnv(process.env);
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        const database = createDatabase(pool);
        const games = new GameRepository(database);
        const registrations = new RegistrationRepository(database);
        const scheduledJobs = new ScheduledJobRepository(database);
        const connection = redisConnection(env.REDIS_URL);
        const queue = new Queue('volley-game-scheduler', { connection });
        const scheduler = new BullMqDelayedJobScheduler(queue);
        const reconciler = new ReconcileGameJobs(scheduledJobs, scheduler);
        const consumer = new GameSchedulerConsumer(games);
        const worker = new Worker(
          'volley-game-scheduler',
          async (bullJob) => {
            const job = deserializeJob(bullJob.data);
            await consumer.process(job);
            await scheduledJobs.remove(job.groupId, job.gameId, job.id);
          },
          { connection, autorun: false },
        );

        const reconcileAll = async (): Promise<void> => {
          let afterId: GameId | undefined;
          do {
            const page = await games.listNonterminal(100, afterId);
            for (const game of page) {
              if (game.id === undefined || game.groupId === undefined) continue;
              await reconciler.execute(
                game,
                await registrations.listCandidates(game.groupId, game.id),
              );
            }
            afterId = page.at(-1)?.id;
            if (page.length < 100) break;
          } while (afterId !== undefined);
        };

        return new GameSchedulerRuntime(worker, reconcileAll, async () => {
          await queue.close();
          await pool.end();
        });
      },
    },
  ],
  exports: [GAME_SCHEDULER_WORKER],
})
export class GameSchedulerModule {}

const redisConnection = (redisUrl: string) => {
  const redis = new URL(redisUrl);
  return {
    host: redis.hostname,
    port: Number(redis.port || 6379),
    password: redis.password || undefined,
  };
};

const deserializeJob = (value: unknown): RequiredJob => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid scheduled job payload');
  }
  const job = value as RequiredJob & { runAt: string | Date };
  return { ...job, runAt: new Date(job.runAt) };
};
