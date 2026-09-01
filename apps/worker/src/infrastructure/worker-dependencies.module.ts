import { Global, Logger, Module } from '@nestjs/common';
import { parseEnv } from '@volley/config';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import type { ManagedWorker } from '../worker-lifecycle.service.js';

export const WORKER_DEPENDENCIES = Symbol.for('volley.worker.dependencies');

export class WorkerDependencies implements ManagedWorker {
  private readonly logger = new Logger(WorkerDependencies.name);
  private closing?: Promise<void>;

  public constructor(
    public readonly pool: Pool,
    public readonly redis: Redis,
  ) {
    this.pool.on('error', () => {
      this.logger.error('PostgreSQL pool connection lost');
    });
  }

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    const closeRedis =
      this.redis.status === 'ready'
        ? this.redis.quit().then(() => undefined)
        : Promise.resolve(this.redis.disconnect());
    await Promise.all([this.pool.end(), closeRedis]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: WORKER_DEPENDENCIES,
      useFactory: (): WorkerDependencies => {
        const env = parseEnv(process.env);
        return new WorkerDependencies(
          new Pool({ connectionString: env.DATABASE_URL }),
          new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }),
        );
      },
    },
  ],
  exports: [WORKER_DEPENDENCIES],
})
export class WorkerDependenciesModule {}
