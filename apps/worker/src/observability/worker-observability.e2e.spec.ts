import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MetricsRegistry } from '@volley/application';
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BullMqJobPublisher } from '../outbox/outbox.consumer.js';
import { OUTBOX_WORKER } from '../outbox/outbox.module.js';
import { GAME_SCHEDULER_WORKER } from '../scheduling/game-scheduler.module.js';
import { GAME_MESSAGE_WORKER } from '../telegram/game-message.consumer.js';
import { WorkerModule } from '../worker.module.js';

const apiRequire = createRequire(
  new URL('../../../api/package.json', import.meta.url),
);
const { FastifyAdapter } = apiRequire('@nestjs/platform-fastify') as {
  FastifyAdapter: new () => unknown;
};

let app: INestApplication | undefined;
let previousEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  previousEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/volley',
    REDIS_URL: 'redis://127.0.0.1:6379',
    BOT_TOKEN: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd',
    TELEGRAM_WEBHOOK_SECRET: '0123456789abcdef',
    PUBLIC_BASE_URL: 'https://localhost:3000',
    LOG_LEVEL: 'info',
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  process.env = previousEnv;
});

it('scrapes metrics produced by a production worker adapter', async () => {
  const idleWorker = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(OUTBOX_WORKER)
    .useValue(idleWorker)
    .overrideProvider(GAME_SCHEDULER_WORKER)
    .useValue(idleWorker)
    .overrideProvider(GAME_MESSAGE_WORKER)
    .useValue(idleWorker)
    .compile();
  app = module.createNestApplication(new FastifyAdapter() as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const initial = await app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/metrics' });
  expect(initial.statusCode).toBe(200);

  const metrics = module.get(MetricsRegistry);
  const publisher = new BullMqJobPublisher(
    {
      name: 'volley-outbox',
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(2),
    } as unknown as Queue,
    metrics,
    () => new Date('2026-09-02T12:00:01.000Z'),
  );
  await publisher.publish({
    id: 'outbox:018f6ba0-62d2-7bd1-8f13-12e0c8424610',
    type: 'GAME_CREATED',
    payload: {},
    occurredAt: new Date('2026-09-02T12:00:00.000Z'),
  });

  const response = await app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/plain');
  expect(response.body).toContain('volley_queue_depth{queue="outbox"} 2');
  expect(response.body).toContain('volley_outbox_lag_seconds_sum 1');
});
