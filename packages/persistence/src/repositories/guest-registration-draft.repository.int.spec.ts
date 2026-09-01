import { asGameId, asTelegramId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GuestRegistrationDraftRepository } from './guest-registration-draft.repository.js';

let container: StartedTestContainer;
let pool: Pool;

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
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

it('persists a pending guest flow by Telegram user', async () => {
  const group = await pool.query<{ id: string }>(
    "INSERT INTO groups (telegram_chat_id, title) VALUES ('-4001', 'Group') RETURNING id",
  );
  const game = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, tentative_prompt_at, tentative_response_deadline,
      reminder_at, member_priority_enabled, state
    ) VALUES (
      $1, 'Game', 'Gym', '2026-09-10T16:00:00Z', 120, 10, 'UTC',
      '2026-09-01T16:00:00Z', '2026-09-09T16:00:00Z',
      '2026-09-09T17:00:00Z', '2026-09-10T14:00:00Z', true, 'OPEN'
    ) RETURNING id`,
    [group.rows[0]!.id],
  );
  const telegramUserId = asTelegramId('401');
  const gameId = asGameId(game.rows[0]!.id);
  const first = new GuestRegistrationDraftRepository(createDatabase(pool));
  await first.save({
    telegramUserId,
    gameId,
    expiresAt: '2026-09-01T12:15:00.000Z',
  });

  const restarted = new GuestRegistrationDraftRepository(createDatabase(pool));
  expect(await restarted.load(telegramUserId)).toEqual({
    telegramUserId,
    gameId,
    expiresAt: '2026-09-01T12:15:00.000Z',
  });
});
