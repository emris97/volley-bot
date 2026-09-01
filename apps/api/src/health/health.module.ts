import { Module } from '@nestjs/common';
import { parseEnv, type AppEnv } from '@volley/config';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { HealthController } from './health.controller.js';
import {
  HealthService,
  POSTGRES_HEALTH_PROBE,
  PostgresHealthProbe,
  REDIS_HEALTH_PROBE,
  RedisHealthProbe,
} from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: POSTGRES_HEALTH_PROBE,
      useFactory: (): PostgresHealthProbe => {
        const env: AppEnv = parseEnv(process.env);
        return new PostgresHealthProbe(
          new Pool({ connectionString: env.DATABASE_URL }),
        );
      },
    },
    {
      provide: REDIS_HEALTH_PROBE,
      useFactory: (): RedisHealthProbe => {
        const env: AppEnv = parseEnv(process.env);
        return new RedisHealthProbe(
          new Redis(env.REDIS_URL, { lazyConnect: true }),
        );
      },
    },
  ],
})
export class HealthModule {}
