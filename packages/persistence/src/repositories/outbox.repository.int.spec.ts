import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { OutboxRepository } from './outbox.repository.js';

describe('OutboxRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repository: OutboxRepository;

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
    repository = new OutboxRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('does not let two dispatchers claim the same event', async () => {
    await insertEvents(pool, 4);
    const leaseUntil = new Date('2026-09-01T12:01:00.000Z');
    const now = new Date('2026-09-01T12:00:00.000Z');

    const [first, second] = await Promise.all([
      repository.claimBatch(4, leaseUntil, now),
      repository.claimBatch(4, leaseUntil, now),
    ]);
    const claimedIds = [...first, ...second].map((event) => event.id);

    expect(claimedIds).toHaveLength(4);
    expect(new Set(claimedIds).size).toBe(4);
  });

  it('hydrates claimed event timestamps as Date instances', async () => {
    await insertEvents(pool, 1);

    const [claimed] = await repository.claimBatch(
      1,
      new Date('2026-09-01T12:01:00.000Z'),
      new Date('2026-09-01T12:00:00.000Z'),
    );

    expect(claimed?.occurredAt).toBeInstanceOf(Date);
  });

  it('releases failed events for retry and records a bounded error', async () => {
    await insertEvents(pool, 1);
    const [claimed] = await repository.claimBatch(
      1,
      new Date('2026-09-01T12:01:00.000Z'),
      new Date('2026-09-01T12:00:00.000Z'),
    );
    expect(claimed).toBeDefined();

    await repository.release(claimed!.id, 'x'.repeat(2_000));

    const result = await pool.query<{
      attempt_count: number;
      claim_expires_at: Date | null;
      last_error: string | null;
    }>(
      'SELECT attempt_count, claim_expires_at, last_error FROM outbox_events WHERE id = $1',
      [claimed!.id],
    );
    expect(result.rows[0]).toMatchObject({
      attempt_count: 1,
      claim_expires_at: null,
    });
    expect(result.rows[0]?.last_error).toHaveLength(1_000);
  });

  it('recovers material-change and cancellation notifications with their original identities', async () => {
    const groupId = randomUUID();
    await pool.query(
      'INSERT INTO groups (id, telegram_chat_id, title) VALUES ($1, $2, $3)',
      [groupId, '-1001000000002', 'Recovery group'],
    );
    const materialId = await insertGameEvent(pool, groupId, 'GAME_UPDATED', {
      materialFields: ['startsAt'],
      startsAtBefore: '2026-09-10T15:00:00.000Z',
      startsAtAfter: '2026-09-11T16:00:00.000Z',
    });
    await insertGameEvent(pool, groupId, 'GAME_UPDATED', {
      materialFields: [],
    });
    const cancellationId = await insertGameEvent(
      pool,
      groupId,
      'GAME_STATE_CHANGED',
      { from: 'OPEN', to: 'CANCELLED' },
    );
    await insertGameEvent(pool, groupId, 'GAME_STATE_CHANGED', {
      from: 'OPEN',
      to: 'CLOSED',
    });

    const recovered = (await repository.listRecoveryBatch(100)).filter(
      ({ type }) => type !== 'GAME_RECOVERY_REFRESH',
    );

    expect(recovered).toHaveLength(2);
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: materialId, type: 'GAME_UPDATED' }),
        expect.objectContaining({
          id: cancellationId,
          type: 'GAME_STATE_CHANGED',
        }),
      ]),
    );
  });

  it('hydrates recovered event timestamps as Date instances', async () => {
    const groupId = randomUUID();
    await pool.query(
      'INSERT INTO groups (id, telegram_chat_id, title) VALUES ($1, $2, $3)',
      [groupId, '-1001000000003', 'Recovery timestamp group'],
    );
    await insertGameEvent(pool, groupId, 'GAME_UPDATED', {
      materialFields: ['startsAt'],
    });

    const recovered = await repository.listRecoveryBatch(100);

    expect(recovered).not.toHaveLength(0);
    expect(
      recovered.every(({ occurredAt }) => occurredAt instanceof Date),
    ).toBe(true);
  });
});

const insertEvents = async (pool: Pool, count: number): Promise<void> => {
  const groupId = randomUUID();
  await pool.query(
    'INSERT INTO groups (id, telegram_chat_id, title) VALUES ($1, $2, $3)',
    [groupId, '-1001000000001', 'Test group'],
  );
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `INSERT INTO outbox_events
        (group_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, 'GAME_CHANGED', 'GAME', $2, $3)`,
      [groupId, randomUUID(), JSON.stringify({ index })],
    );
  }
};

const insertGameEvent = async (
  pool: Pool,
  groupId: string,
  eventType: 'GAME_UPDATED' | 'GAME_STATE_CHANGED',
  payload: Record<string, unknown>,
): Promise<string> => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events
      (group_id, event_type, aggregate_type, aggregate_id, payload, published_at)
     VALUES ($1, $2, 'GAME', $3, $4, NOW())
     RETURNING id`,
    [groupId, eventType, randomUUID(), JSON.stringify(payload)],
  );
  return result.rows[0]!.id;
};
