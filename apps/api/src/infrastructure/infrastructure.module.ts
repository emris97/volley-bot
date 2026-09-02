import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { parseEnv, type AppEnv } from '@volley/config';
import { createDatabase, type Database } from '@volley/persistence';
import { Redis } from 'ioredis';
import { Pool } from 'pg';

export const APP_ENV = Symbol('APP_ENV');
export const DATABASE_POOL = Symbol('DATABASE_POOL');
export const DATABASE = Symbol('DATABASE');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  public constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect(false);
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_ENV, useFactory: (): AppEnv => parseEnv(process.env) },
    {
      provide: DATABASE_POOL,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): Pool =>
        new Pool({ connectionString: env.DATABASE_URL }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): Database => createDatabase(pool),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): Redis =>
        new Redis(env.REDIS_URL, { lazyConnect: true }),
    },
    InfrastructureLifecycle,
  ],
  exports: [APP_ENV, DATABASE_POOL, DATABASE, REDIS_CLIENT],
})
export class InfrastructureModule {}
