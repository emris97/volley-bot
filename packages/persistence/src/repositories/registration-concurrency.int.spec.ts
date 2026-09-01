import {
  asGameId,
  asGroupId,
  asUserId,
  type RegistrationState,
} from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { RegistrationRepository } from './registration.repository.js';

describe('RegistrationRepository concurrency', () => {
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
      max: 5,
    });
    await applyTestMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('serializes final-place clicks and keeps repeated callbacks idempotent', async () => {
    const groupId = await insertGroup(pool);
    const gameId = await insertOpenGame(pool, groupId, 1);
    const [firstUserId, secondUserId] = await Promise.all([
      insertUser(pool, '101'),
      insertUser(pool, '102'),
    ]);
    const registrations = new RegistrationRepository(createDatabase(pool));

    const [first, second] = await Promise.all([
      registrations.registerParticipant({
        groupId,
        gameId,
        userId: firstUserId,
        intent: 'CONFIRMED',
        membershipPriority: 1,
        idempotencyKey: 'callback:1',
      }),
      registrations.registerParticipant({
        groupId,
        gameId,
        userId: secondUserId,
        intent: 'CONFIRMED',
        membershipPriority: 1,
        idempotencyKey: 'callback:2',
      }),
    ]);

    expect([first.state, second.state].sort()).toEqual([
      'ROSTERED',
      'WAITLISTED',
    ] satisfies RegistrationState[]);

    const repeated = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:1-repeat',
    });
    expect(repeated.registrationId).toBe(first.registrationId);
    expect(await activeCount(pool, gameId, firstUserId)).toBe(1);
  });

  it('rejects withdrawal of another participant and promotes the waiter', async () => {
    const groupId = await insertGroupWithChat(pool, '-2002');
    const gameId = await insertOpenGame(pool, groupId, 1);
    const ownerUserId = await insertUser(pool, '201');
    const waiterUserId = await insertUser(pool, '202');
    const strangerUserId = await insertUser(pool, '203');
    const registrations = new RegistrationRepository(createDatabase(pool));
    const rostered = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: ownerUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:withdraw-owner',
    });
    const waiter = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: waiterUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:withdraw-waiter',
    });

    await expect(
      registrations.withdraw({
        groupId,
        gameId,
        registrationId: rostered.registrationId,
        actorUserId: strangerUserId,
        reason: 'NOT_MINE',
      }),
    ).rejects.toThrow(/own registration/i);

    await registrations.withdraw({
      groupId,
      gameId,
      registrationId: rostered.registrationId,
      actorUserId: ownerUserId,
      reason: 'PARTICIPANT_WITHDREW',
    });
    expect(await registrationState(pool, waiter.registrationId)).toBe(
      'ROSTERED',
    );
  });
});

const insertGroup = async (pool: Pool) => {
  return insertGroupWithChat(pool, '-2001');
};

const insertGroupWithChat = async (pool: Pool, chatId: string) => {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO groups (telegram_chat_id, title, onboarding_state) VALUES ($1, 'Group', 'CONFIGURED') RETURNING id",
    [chatId],
  );
  return asGroupId(result.rows[0]!.id);
};

const registrationState = async (pool: Pool, registrationId: string) => {
  const result = await pool.query<{ state: RegistrationState }>(
    'SELECT state FROM registrations WHERE id = $1',
    [registrationId],
  );
  return result.rows[0]!.state;
};

const insertUser = async (pool: Pool, telegramId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id',
    [telegramId],
  );
  return asUserId(result.rows[0]!.id);
};

const insertOpenGame = async (
  pool: Pool,
  groupId: string,
  capacity: number,
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, registration_closes_at, tentative_prompt_at,
      tentative_response_deadline, reminder_at, member_priority_enabled, state
    ) VALUES (
      $1, 'Game', 'Gym', '2026-09-10T16:00:00Z', 120, $2, 'UTC',
      '2026-09-01T16:00:00Z', '2026-09-10T15:00:00Z',
      '2026-09-09T16:00:00Z', '2026-09-09T17:00:00Z',
      '2026-09-10T14:00:00Z', true, 'OPEN'
    ) RETURNING id`,
    [groupId, capacity],
  );
  return asGameId(result.rows[0]!.id);
};

const activeCount = async (pool: Pool, gameId: string, userId: string) => {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM registrations WHERE game_id = $1 AND user_id = $2 AND state <> 'CANCELLED'",
    [gameId, userId],
  );
  return Number(result.rows[0]!.count);
};
