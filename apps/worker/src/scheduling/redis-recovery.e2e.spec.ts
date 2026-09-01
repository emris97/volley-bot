import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReconcileGameJobs, requiredJobsForGame } from '@volley/application';
import { asGameId, asGroupId, type Game } from '@volley/domain';
import {
  createDatabase,
  GameRepository,
  NotificationRepository,
  OutboxRepository,
  RegistrationRepository,
  ScheduledJobRepository,
} from '@volley/persistence';
import { applyTestMigrations } from '../../../../packages/persistence/src/migrations/migration-test-helper.js';
import { NotificationConsumer } from '../notifications/notification.consumer.js';
import { BullMqJobPublisher } from '../outbox/outbox.consumer.js';
import { OutboxEventRouter } from '../telegram/game-message.consumer.js';
import {
  BullMqDelayedJobScheduler,
  GameSchedulerConsumer,
} from './game-scheduler.consumer.js';

describe('Redis recovery with durable Postgres metadata', () => {
  let postgres: StartedTestContainer;
  let redisContainer: StartedTestContainer;
  let pool: Pool;
  let redis: Redis;
  let schedulerQueue: Queue;
  let outboxQueue: Queue;
  let connection: { host: string; port: number };

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      new GenericContainer('postgres:16-alpine')
        .withEnvironment({
          POSTGRES_DB: 'volley',
          POSTGRES_PASSWORD: 'postgres',
          POSTGRES_USER: 'postgres',
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start(),
      new GenericContainer('redis:8-alpine')
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);
    pool = new Pool({
      connectionString: `postgresql://postgres:postgres@${postgres.getHost()}:${postgres.getMappedPort(5432)}/volley`,
    });
    await applyTestMigrations(pool);
    connection = {
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    };
    redis = new Redis(connection);
    schedulerQueue = new Queue('volley-game-scheduler-recovery', {
      connection,
    });
    outboxQueue = new Queue('volley-outbox-recovery', { connection });
  }, 60_000);

  afterAll(async () => {
    await schedulerQueue?.close();
    await outboxQueue?.close();
    await redis?.quit();
    await pool?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  it('rebuilds scheduled and outbox queues, then converges notification state', async () => {
    const database = createDatabase(pool);
    const games = new GameRepository(database);
    const registrations = new RegistrationRepository(database);
    const scheduledJobs = new ScheduledJobRepository(database);
    const outbox = new OutboxRepository(database);
    const groupId = asGroupId(randomUUID());
    const gameId = asGameId(randomUUID());
    await pool.query(
      "INSERT INTO groups (id, telegram_chat_id, title) VALUES ($1, '-1001', 'Recovery')",
      [groupId],
    );
    await games.insert(game(groupId, gameId));
    const user = await pool.query<{ id: string }>(
      "INSERT INTO users (telegram_user_id, display_name) VALUES ('42', 'Игрок') RETURNING id",
    );
    await pool.query(
      `INSERT INTO registrations (
        group_id, game_id, user_id, kind, state, membership_priority,
        idempotency_key
      ) VALUES ($1, $2, $3, 'MEMBER', 'TENTATIVE', 0, 'recovery')`,
      [groupId, gameId, user.rows[0]!.id],
    );
    const storedGame = (await games.findById(groupId, gameId))!;
    const candidates = await registrations.listCandidates(groupId, gameId);
    const reconciler = new ReconcileGameJobs(
      scheduledJobs,
      new BullMqDelayedJobScheduler(schedulerQueue),
    );
    await reconciler.execute(storedGame, candidates);
    await replayOutbox(outbox, new BullMqJobPublisher(outboxQueue));

    await redis.flushdb();
    const prompt = requiredJobsForGame(storedGame, candidates).find(
      (job) => job.kind === 'REQUEST_TENTATIVE_CONFIRMATION',
    )!;
    expect(await schedulerQueue.getJob(prompt.id)).toBeUndefined();

    await reconciler.execute(storedGame, candidates);
    await replayOutbox(outbox, new BullMqJobPublisher(outboxQueue));

    expect(await schedulerQueue.getJob(prompt.id)).toBeDefined();
    const [event] = await outbox.listRecoveryBatch(1);
    const outboxJobId = `outbox:${event!.id}:event`;
    expect(await outboxQueue.getJob(outboxJobId)).toBeDefined();

    const canonicalQueue = new Queue('volley-game-messages-recovery', {
      connection,
    });
    const notificationQueue = new Queue('volley-notifications-recovery', {
      connection,
    });
    const router = new OutboxEventRouter(canonicalQueue, notificationQueue);
    const routerWorker = new Worker(
      outboxQueue.name,
      async (job) => router.process(job.name, job.data, job.id!),
      { connection },
    );
    await vi.waitFor(
      async () => {
        expect(
          await canonicalQueue.getJob(
            outboxJobId.replace(/:event$/, ':canonical'),
          ),
        ).toBeDefined();
      },
      { timeout: 10_000 },
    );
    await routerWorker.close();
    await canonicalQueue.close();
    await notificationQueue.close();

    const notifications = new NotificationRepository(database);
    const sender = { send: vi.fn() };
    const notificationConsumer = new NotificationConsumer(
      notifications,
      sender as never,
      registrations,
    );
    const schedulerConsumer = new GameSchedulerConsumer(games, (job) =>
      notificationConsumer.process(job),
    );
    const schedulerWorker = new Worker(
      schedulerQueue.name,
      async (bullJob) => {
        const job = {
          ...bullJob.data,
          runAt: new Date(bullJob.data.runAt),
        };
        await schedulerConsumer.process(job);
        await scheduledJobs.markCompleted(job.groupId, job.gameId, job.id);
      },
      { connection },
    );
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    });
    await schedulerWorker.close();
    await redis.flushdb();
    await reconciler.execute(storedGame, candidates);

    expect(sender.send).toHaveBeenCalledOnce();
    expect(await schedulerQueue.getJob(prompt.id)).toBeUndefined();
    expect(
      (await scheduledJobs.listForGame(groupId, gameId)).find(
        (job) => job.id === prompt.id,
      )?.completed,
    ).toBe(true);
  });
});

const replayOutbox = async (
  repository: OutboxRepository,
  publisher: BullMqJobPublisher,
): Promise<void> => {
  for (const event of await repository.listRecoveryBatch(100)) {
    await publisher.publish({
      id: `outbox:${event.id}`,
      type: event.type,
      payload: {
        ...event.payload,
        groupId: event.groupId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
      },
      occurredAt: event.occurredAt,
    });
  }
};

const game = (
  groupId: ReturnType<typeof asGroupId>,
  id: ReturnType<typeof asGameId>,
): Game => ({
  id,
  groupId,
  sourceTemplateId: null,
  name: 'Recovery game',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-10T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
  timeZone: 'UTC',
  registrationOpensAt: new Date('2026-09-02T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-10T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-08-31T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-09T17:00:00.000Z'),
  reminderAt: new Date('2026-09-10T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'SCHEDULED',
  scheduleRevision: 1,
  canonicalTelegramMessageId: null,
});
