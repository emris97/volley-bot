import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ReconcileGameJobs } from '@volley/application';
import type { GameId } from '@volley/domain';
import {
  createDatabase,
  GameRepository,
  RegistrationRepository,
  ScheduledJobRepository,
} from '@volley/persistence';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { BullMqDelayedJobScheduler } from '../apps/worker/src/scheduling/game-scheduler.consumer.js';

@Injectable()
class ReconcileJobsCommand {
  public async run(): Promise<{ pages: number; games: number; jobs: number }> {
    const databaseUrl = requiredUrl('DATABASE_URL', 'postgresql:');
    const redisUrl = requiredUrl('REDIS_URL', 'redis:');
    const pool = new Pool({ connectionString: databaseUrl.toString() });
    const queue = new Queue('volley-game-scheduler', {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        password: redisUrl.password || undefined,
      },
    });
    try {
      const database = createDatabase(pool);
      const games = new GameRepository(database);
      const registrations = new RegistrationRepository(database);
      const reconciler = new ReconcileGameJobs(
        new ScheduledJobRepository(database),
        new BullMqDelayedJobScheduler(queue),
      );
      let afterId: GameId | undefined;
      let pages = 0;
      let gameCount = 0;
      let jobs = 0;
      do {
        const page = await games.listNonterminal(100, afterId);
        if (page.length === 0) break;
        pages += 1;
        for (const game of page) {
          if (game.id === undefined || game.groupId === undefined) continue;
          const result = await reconciler.execute(
            game,
            await registrations.listCandidates(game.groupId, game.id),
          );
          gameCount += 1;
          jobs += result.desired;
        }
        afterId = page.at(-1)?.id;
        if (page.length < 100) break;
      } while (afterId !== undefined);
      return { pages, games: gameCount, jobs };
    } finally {
      await queue.close();
      await pool.end();
    }
  }
}

@Module({ providers: [ReconcileJobsCommand] })
class ReconcileJobsModule {}

const main = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(ReconcileJobsModule, {
    logger: false,
  });
  try {
    const result = await app.get(ReconcileJobsCommand).run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
};

const requiredUrl = (name: string, protocol: string): URL => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== protocol)
    throw new Error(`${name} must use ${protocol}`);
  return url;
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
