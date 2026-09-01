import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

export interface HealthProbe {
  check(): Promise<void>;
  close?(): Promise<void>;
}

export const POSTGRES_HEALTH_PROBE = Symbol('POSTGRES_HEALTH_PROBE');
export const REDIS_HEALTH_PROBE = Symbol('REDIS_HEALTH_PROBE');

export class PostgresHealthProbe implements HealthProbe {
  constructor(private readonly pool: Pool) {}

  async check(): Promise<void> {
    await this.pool.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class RedisHealthProbe implements HealthProbe {
  constructor(private readonly redis: Redis) {}

  async check(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

@Injectable()
export class HealthService implements OnApplicationShutdown {
  constructor(
    @Inject(POSTGRES_HEALTH_PROBE)
    private readonly postgres: HealthProbe,
    @Inject(REDIS_HEALTH_PROBE)
    private readonly redis: HealthProbe,
  ) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: 'ok' }> {
    const [postgres, redis] = await Promise.allSettled([
      this.postgres.check(),
      this.redis.check(),
    ]);

    if (postgres.status === 'rejected' || redis.status === 'rejected') {
      throw new ServiceUnavailableException({
        status: 'error',
        dependencies: {
          postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
          redis: redis.status === 'fulfilled' ? 'up' : 'down',
        },
      });
    }

    return { status: 'ok' };
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.postgres.close?.(), this.redis.close?.()]);
  }
}
