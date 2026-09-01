import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POSTGRES_HEALTH_PROBE,
  REDIS_HEALTH_PROBE,
  type HealthProbe,
} from './health.service.js';
import { HealthModule } from './health.module.js';

describe('health endpoints', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const createApp = async (
    postgres: HealthProbe,
    redis: HealthProbe,
  ): Promise<NestFastifyApplication> => {
    const module = await Test.createTestingModule({
      imports: [HealthModule],
    })
      .overrideProvider(POSTGRES_HEALTH_PROBE)
      .useValue(postgres)
      .overrideProvider(REDIS_HEALTH_PROBE)
      .useValue(redis)
      .compile();

    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    return app;
  };

  it('reports liveness independently from dependencies', async () => {
    const postgres = { check: vi.fn().mockRejectedValue(new Error('down')) };
    const redis = { check: vi.fn().mockRejectedValue(new Error('down')) };
    const runningApp = await createApp(postgres, redis);

    const response = await runningApp.inject({
      method: 'GET',
      url: '/health/live',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(postgres.check).not.toHaveBeenCalled();
    expect(redis.check).not.toHaveBeenCalled();
  });

  it('reports readiness failure when a dependency is unavailable', async () => {
    const postgres = { check: vi.fn().mockResolvedValue(undefined) };
    const redis = { check: vi.fn().mockRejectedValue(new Error('down')) };
    const runningApp = await createApp(postgres, redis);

    const response = await runningApp.inject({
      method: 'GET',
      url: '/health/ready',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error' });
    expect(postgres.check).toHaveBeenCalledOnce();
    expect(redis.check).toHaveBeenCalledOnce();
  });
});
