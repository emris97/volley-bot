import { asGameId, asGroupId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GameMessageRepository } from './game-message.repository.js';

describe('GameMessageRepository pin recovery', () => {
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

  beforeEach(async () => {
    await pool.query('TRUNCATE registrations, games, groups CASCADE');
  });

  it('records and clears a tenant-scoped canonical pin failure', async () => {
    const group = await pool.query<{ id: string }>(
      `INSERT INTO groups (
        telegram_chat_id, title, onboarding_state, time_zone, pin_game_messages
      ) VALUES (-4201, 'Group', 'CONFIGURED', 'UTC', true) RETURNING id`,
    );
    const groupId = asGroupId(group.rows[0]!.id);
    const game = await pool.query<{ id: string }>(
      `INSERT INTO games (
        group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
        registration_opens_at, registration_closes_at, tentative_prompt_at,
        tentative_response_deadline, reminder_at, member_priority_enabled, state
      ) VALUES (
        $1, 'Game', 'Gym', '2026-09-11T16:00:00.000Z', 120, 12, 'UTC',
        '2026-09-01T16:00:00.000Z', '2026-09-11T15:00:00.000Z',
        '2026-09-11T13:00:00.000Z', '2026-09-11T14:00:00.000Z',
        '2026-09-11T15:00:00.000Z', true, 'OPEN'
      ) RETURNING id`,
      [groupId],
    );
    const gameId = asGameId(game.rows[0]!.id);
    const repository = new GameMessageRepository(createDatabase(pool), pool);

    await repository.recordPinFailure(groupId, gameId);
    await expect(repository.load(groupId, gameId)).resolves.toMatchObject({
      canonicalPinFailedAt: expect.any(Date),
    });

    await repository.clearPinFailure(groupId, gameId);
    await expect(repository.load(groupId, gameId)).resolves.toMatchObject({
      canonicalPinFailedAt: null,
    });
  });
});
