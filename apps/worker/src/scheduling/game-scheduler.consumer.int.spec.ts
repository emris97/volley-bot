import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ReconcileGameJobs,
  requiredJobsForGame,
  type DelayedJobScheduler,
  type RequiredJob,
} from '@volley/application';
import { asGameId, asGroupId, type Game } from '@volley/domain';
import {
  createDatabase,
  GameRepository,
  ScheduledJobRepository,
} from '@volley/persistence';
import { applyTestMigrations } from '../../../../packages/persistence/src/migrations/migration-test-helper.js';
import { GameSchedulerConsumer } from './game-scheduler.consumer.js';

describe('game scheduling', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let games: GameRepository;
  let scheduledJobs: ScheduledJobRepository;

  beforeAll(async () => {
    container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'volley',
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_USER: 'postgres',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
      )
      .start();
    pool = new Pool({
      connectionString: `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/volley`,
    });
    await applyTestMigrations(pool);
    const database = createDatabase(pool);
    games = new GameRepository(database);
    scheduledJobs = new ScheduledJobRepository(database);
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE scheduled_jobs, registrations, games, outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('reconciles desired jobs and removes obsolete revisions', async () => {
    const game = await insertGame(pool, 1);
    const queue = new FakeDelayedJobScheduler();
    const reconciler = new ReconcileGameJobs(scheduledJobs, queue);

    await reconciler.execute(game, []);
    const firstIds = queue.ids();
    await reconciler.execute({ ...game, scheduleRevision: 2 }, []);

    expect(firstIds).toHaveLength(2);
    expect(queue.ids()).toEqual(
      requiredJobsForGame({ ...game, scheduleRevision: 2 }, [])
        .map((job) => job.id)
        .sort(),
    );
    expect(
      await scheduledJobs.listForGame(game.groupId!, game.id!),
    ).toHaveLength(2);
  });

  it('ignores stale and duplicate state-transition jobs', async () => {
    const game = await insertGame(pool, 1);
    const consumer = new GameSchedulerConsumer(games);
    const openJob = requiredJobsForGame(game, [])[0]!;

    await consumer.process({ ...openJob, scheduleRevision: 0 });
    expect(await stateOf(pool, game.id!)).toBe('SCHEDULED');

    await consumer.process(openJob);
    await consumer.process(openJob);
    expect(await stateOf(pool, game.id!)).toBe('OPEN');
    expect(await eventCount(pool, 'GAME_STATE_CHANGED')).toBe(1);
  });

  it('does not run notification jobs for stale or terminal games', async () => {
    const game = await insertGame(pool, 1);
    const handleNotification = vi.fn();
    const consumer = new GameSchedulerConsumer(games, handleNotification);
    const reminder = {
      ...requiredJobsForGame(game, [rosteredCandidate()]).find(
        (job) => job.kind === 'REMIND_PARTICIPANTS',
      )!,
    };

    await consumer.process({ ...reminder, scheduleRevision: 0 });
    await pool.query("UPDATE games SET state = 'CANCELLED' WHERE id = $1", [
      game.id,
    ]);
    await consumer.process(reminder);

    expect(handleNotification).not.toHaveBeenCalled();
  });

  it('lists terminal games while they still have scheduled jobs', async () => {
    const game = await insertGame(pool, 1);
    const reconciler = new ReconcileGameJobs(
      scheduledJobs,
      new FakeDelayedJobScheduler(),
    );
    await reconciler.execute(game, []);
    await pool.query("UPDATE games SET state = 'CANCELLED' WHERE id = $1", [
      game.id,
    ]);

    const page = await games.listForReconciliation(100);

    expect(page.map((item) => item.id)).toContain(game.id);
  });
});

class FakeDelayedJobScheduler implements DelayedJobScheduler {
  private readonly jobs = new Map<string, RequiredJob>();

  public async ensure(job: RequiredJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  public async remove(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  public ids(): string[] {
    return [...this.jobs.keys()].sort();
  }
}

const insertGame = async (
  pool: Pool,
  scheduleRevision: number,
): Promise<Game> => {
  const groupId = randomUUID();
  const gameId = randomUUID();
  await pool.query(
    'INSERT INTO groups (id, telegram_chat_id, title) VALUES ($1, $2, $3)',
    [groupId, '-1001000000001', 'Test group'],
  );
  await pool.query(
    `INSERT INTO games (
      id, group_id, name, venue, starts_at, duration_minutes, capacity,
      time_zone, registration_opens_at, registration_closes_at,
      tentative_prompt_at, tentative_response_deadline, reminder_at,
      member_priority_enabled, currency, rounding_mode, state, schedule_revision
    ) VALUES (
      $1, $2, 'Friday volleyball', 'Arena', $3, 120, 12,
      'Europe/Astrakhan', $4, $5, $6, $7, $8,
      true, 'RUB', 'EXACT', 'SCHEDULED', $9
    )`,
    [
      gameId,
      groupId,
      new Date('2026-09-04T16:00:00.000Z'),
      new Date('2026-08-28T16:00:00.000Z'),
      new Date('2026-09-04T15:00:00.000Z'),
      new Date('2026-09-03T16:00:00.000Z'),
      new Date('2026-09-03T17:00:00.000Z'),
      new Date('2026-09-04T14:00:00.000Z'),
      scheduleRevision,
    ],
  );
  return {
    id: asGameId(gameId),
    groupId: asGroupId(groupId),
    sourceTemplateId: null,
    name: 'Friday volleyball',
    venue: 'Arena',
    address: null,
    startsAt: new Date('2026-09-04T16:00:00.000Z'),
    durationMinutes: 120,
    capacity: 12,
    timeZone: 'Europe/Astrakhan',
    registrationOpensAt: new Date('2026-08-28T16:00:00.000Z'),
    registrationClosesAt: new Date('2026-09-04T15:00:00.000Z'),
    tentativePromptAt: new Date('2026-09-03T16:00:00.000Z'),
    tentativeResponseDeadline: new Date('2026-09-03T17:00:00.000Z'),
    reminderAt: new Date('2026-09-04T14:00:00.000Z'),
    memberPriorityEnabled: true,
    totalCostMinor: null,
    currency: 'RUB',
    roundingMode: 'EXACT',
    state: 'SCHEDULED',
    scheduleRevision,
    canonicalTelegramMessageId: null,
  };
};

const stateOf = async (pool: Pool, gameId: string): Promise<string> => {
  const result = await pool.query<{ state: string }>(
    'SELECT state FROM games WHERE id = $1',
    [gameId],
  );
  return result.rows[0]!.state;
};

const eventCount = async (pool: Pool, type: string): Promise<number> => {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM outbox_events WHERE event_type = $1',
    [type],
  );
  return Number(result.rows[0]!.count);
};

const rosteredCandidate = () => ({
  id: '018f6ba0-62d2-7bd1-8f13-12e0c8424699' as never,
  kind: 'MEMBER' as const,
  state: 'ROSTERED' as const,
  manualRank: null,
  membershipPriority: 0,
  confirmedAt: new Date('2026-08-30T12:00:00.000Z'),
});
