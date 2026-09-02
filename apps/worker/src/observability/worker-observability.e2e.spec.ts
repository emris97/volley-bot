import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MetricsRegistry } from '@volley/application';
import type { Queue } from 'bullmq';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  WORKER_DEPENDENCIES,
  WorkerDependencies,
} from '../infrastructure/worker-dependencies.module.js';
import { BullMqJobPublisher } from '../outbox/outbox.consumer.js';
import { OUTBOX_WORKER } from '../outbox/outbox.module.js';
import { GAME_SCHEDULER_WORKER } from '../scheduling/game-scheduler.module.js';
import { GAME_MESSAGE_WORKER } from '../telegram/game-message.consumer.js';
import { WorkerModule } from '../worker.module.js';
import { WORKER_RUN_STATE, type WorkerRunState } from './worker-run-state.js';

const apiRequire = createRequire(
  new URL('../../../api/package.json', import.meta.url),
);
const { FastifyAdapter } = apiRequire('@nestjs/platform-fastify') as {
  FastifyAdapter: new () => unknown;
};

let app: INestApplication | undefined;
let previousEnv: NodeJS.ProcessEnv;

interface TestWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface TestDependencies extends TestWorker {
  pool: { query(sql: string): Promise<unknown> };
  redis: { status: string; ping(): Promise<string> };
}

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
  const module = await createProductionWorkerApp(healthyDependencies());

  const initial = await app!
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

  const response = await app!
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/plain');
  expect(response.body).toContain('volley_queue_depth{queue="outbox"} 2');
  expect(response.body).toContain('volley_outbox_lag_seconds_sum 1');
});

it('reports ready when PostgreSQL and Redis are reachable', async () => {
  await createProductionWorkerApp(healthyDependencies());

  const response = await injectReady();

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

it('reports unavailable when the worker PostgreSQL dependency fails', async () => {
  await createProductionWorkerApp({
    ...healthyDependencies(),
    pool: {
      query: vi
        .fn()
        .mockRejectedValue(
          new Error('postgresql://operator:database-secret@database/volley'),
        ),
    },
  });

  const response = await injectReady();

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(response.body).not.toContain('database-secret');
});

it('reports unavailable when the worker Redis dependency fails', async () => {
  await createProductionWorkerApp({
    ...healthyDependencies(),
    redis: {
      status: 'ready',
      ping: vi
        .fn()
        .mockRejectedValue(
          new Error('redis://operator:redis-secret@redis:6379'),
        ),
    },
  });

  const response = await injectReady();

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'unavailable' });
  expect(response.body).not.toContain('redis-secret');
});

it('reports unavailable when a required production consumer terminates unexpectedly', async () => {
  const runState = healthyRunState();
  runState.isReady.mockReturnValue(false);
  await createProductionWorkerApp(healthyDependencies(), {}, runState);

  const live = await app!.getHttpAdapter().getInstance().inject({
    method: 'GET',
    url: '/health/live',
  });
  const ready = await injectReady();

  expect(live.statusCode).toBe(200);
  expect(ready.statusCode).toBe(503);
  expect(ready.json()).toEqual({ status: 'unavailable' });
});

it('keeps the worker live and non-ready after an idle PostgreSQL client error', async () => {
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn().mockRejectedValue(new Error('database unavailable')),
    end: vi.fn().mockResolvedValue(undefined),
  });
  const redis = {
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };
  const logger = vi
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  await createProductionWorkerApp(
    new WorkerDependencies(pool as never, redis as never),
  );

  expect(() =>
    pool.emit(
      'error',
      new Error('postgresql://operator:idle-client-secret@postgres/volley'),
    ),
  ).not.toThrow();
  const live = await app!.getHttpAdapter().getInstance().inject({
    method: 'GET',
    url: '/health/live',
  });
  const ready = await injectReady();

  expect(live.statusCode).toBe(200);
  expect(live.json()).toEqual({ status: 'ok' });
  expect(ready.statusCode).toBe(503);
  expect(ready.json()).toEqual({ status: 'unavailable' });
  expect(logger).toHaveBeenCalledWith('PostgreSQL pool connection lost');
  expect(JSON.stringify(logger.mock.calls)).not.toContain('idle-client-secret');
});

it('closes shared dependencies once after production consumers drain', async () => {
  let releaseConsumer!: () => void;
  const consumerStopped = new Promise<void>((resolve) => {
    releaseConsumer = resolve;
  });
  const heldConsumer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(() => consumerStopped),
  };
  const dependencies = healthyDependencies();
  await createProductionWorkerApp(dependencies, {
    gameMessages: heldConsumer,
  });

  const close = app!.close();
  await vi.waitFor(() => expect(heldConsumer.stop).toHaveBeenCalledOnce());
  expect(dependencies.stop).not.toHaveBeenCalled();

  releaseConsumer();
  await close;
  app = undefined;

  expect(dependencies.stop).toHaveBeenCalledOnce();
});

const createProductionWorkerApp = async (
  dependencies: TestDependencies,
  workers: {
    outbox?: TestWorker;
    scheduler?: TestWorker;
    gameMessages?: TestWorker;
  } = {},
  runState: WorkerRunState = healthyRunState(),
) => {
  const idleWorker = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const module = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(WORKER_DEPENDENCIES)
    .useValue(dependencies)
    .overrideProvider(OUTBOX_WORKER)
    .useValue(workers.outbox ?? idleWorker)
    .overrideProvider(GAME_SCHEDULER_WORKER)
    .useValue(workers.scheduler ?? idleWorker)
    .overrideProvider(GAME_MESSAGE_WORKER)
    .useValue(workers.gameMessages ?? idleWorker)
    .overrideProvider(WORKER_RUN_STATE)
    .useValue(runState)
    .compile();
  app = module.createNestApplication(new FastifyAdapter() as never);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return module;
};

const healthyRunState = () => ({
  isReady: vi.fn().mockReturnValue(true),
});

const injectReady = () =>
  app!.getHttpAdapter().getInstance().inject({
    method: 'GET',
    url: '/health/ready',
  });

const healthyDependencies = () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] }),
  },
  redis: {
    status: 'ready',
    ping: vi.fn().mockResolvedValue('PONG'),
  },
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});
