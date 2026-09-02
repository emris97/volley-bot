import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import {
  DATABASE_POOL,
  REDIS_CLIENT,
} from '../infrastructure/infrastructure.module.js';
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
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): PostgresHealthProbe =>
        new PostgresHealthProbe(pool),
    },
    {
      provide: REDIS_HEALTH_PROBE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis): RedisHealthProbe =>
        new RedisHealthProbe(redis),
    },
  ],
})
export class HealthModule {}
