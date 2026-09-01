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
