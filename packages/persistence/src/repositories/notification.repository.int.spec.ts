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
import { NotificationRepository } from './notification.repository.js';

describe('NotificationRepository game-event recipients', () => {
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
    await pool.query(
      'TRUNCATE notification_deliveries, registrations, games, group_members, groups, users CASCADE',
    );
  });

  it('lists tentative, rostered, and waitlisted registrations without schedule or game-state filtering', async () => {
    const groupId = await insertGroup(pool, '-4101');
    const otherGroupId = await insertGroup(pool, '-4102');
    const gameId = await insertGame(pool, groupId, 'CANCELLED', 7);
    const otherGameId = await insertGame(pool, otherGroupId, 'OPEN', 0);
    const tentative = await insertMemberRegistration(
      pool,
      groupId,
      gameId,
      '4101',
      'TENTATIVE',
    );
    const rostered = await insertMemberRegistration(
      pool,
      groupId,
      gameId,
      '4102',
      'ROSTERED',
    );
    const inviter = await insertUser(pool, '4199');
    const guest = await insertGuestRegistration(
      pool,
      groupId,
      gameId,
      inviter,
      'WAITLISTED',
    );
    await insertMemberRegistration(pool, groupId, gameId, '4103', 'CANCELLED');
    await insertMemberRegistration(
      pool,
      otherGroupId,
      otherGameId,
      '4104',
      'ROSTERED',
    );

    const records = await new NotificationRepository(
      createDatabase(pool),
    ).listActiveForGame(asGroupId(groupId), asGameId(gameId));

    expect(records.map(({ registrationId }) => registrationId)).toEqual([
      tentative,
      rostered,
      guest,
    ]);
    expect(records[2]).toMatchObject({
      kind: 'GUEST',
      telegramUserId: null,
      inviterTelegramUserId: '4199',
      displayName: 'Гость',
      game: {
        name: 'Изменённая игра',
        venue: 'Зал',
        address: 'Адрес',
        timeZone: 'Europe/Astrakhan',
      },
    });
    expect(records[0]!.game.startsAt).toBeInstanceOf(Date);
    expect(records[0]!.game.startsAt.toISOString()).toBe(
      '2026-09-11T16:00:00.000Z',
    );
  });
});

const insertGroup = async (pool: Pool, telegramChatId: string) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO groups (
      telegram_chat_id, title, onboarding_state, time_zone
    ) VALUES ($1, 'Group', 'CONFIGURED', 'Europe/Astrakhan') RETURNING id`,
    [telegramChatId],
  );
  return result.rows[0]!.id;
};

const insertGame = async (
  pool: Pool,
  groupId: string,
  state: 'OPEN' | 'CANCELLED',
  scheduleRevision: number,
) => {
  const startsAt = new Date('2026-09-11T16:00:00.000Z');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, address, starts_at, duration_minutes, capacity,
      time_zone, registration_opens_at, registration_closes_at,
      tentative_prompt_at, tentative_response_deadline, reminder_at,
      member_priority_enabled, state, schedule_revision
    ) VALUES (
      $1, 'Изменённая игра', 'Зал', 'Адрес', $2, 120, 12,
      'Europe/Astrakhan', $3, $4, $5, $6, $7, true, $8, $9
    ) RETURNING id`,
    [
      groupId,
      startsAt,
      new Date('2026-09-01T16:00:00.000Z'),
      new Date('2026-09-11T15:00:00.000Z'),
      new Date('2026-09-11T13:00:00.000Z'),
      new Date('2026-09-11T14:00:00.000Z'),
      new Date('2026-09-11T15:00:00.000Z'),
      state,
      scheduleRevision,
    ],
  );
  return result.rows[0]!.id;
};

const insertUser = async (pool: Pool, telegramUserId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id',
    [telegramUserId, `Игрок ${telegramUserId}`],
  );
  return result.rows[0]!.id;
};

const insertMemberRegistration = async (
  pool: Pool,
  groupId: string,
  gameId: string,
  telegramUserId: string,
  state: 'TENTATIVE' | 'ROSTERED' | 'CANCELLED',
) => {
  const userId = await insertUser(pool, telegramUserId);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO registrations (
      group_id, game_id, user_id, kind, membership_priority, state,
      idempotency_key, confirmed_at
    ) VALUES ($1, $2, $3, 'MEMBER', 1, $4, $5, $6) RETURNING id`,
    [
      groupId,
      gameId,
      userId,
      state,
      `notification:${telegramUserId}`,
      state === 'TENTATIVE' ? null : new Date(),
    ],
  );
  return result.rows[0]!.id;
};

const insertGuestRegistration = async (
  pool: Pool,
  groupId: string,
  gameId: string,
  inviterUserId: string,
  state: 'WAITLISTED',
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO registrations (
      group_id, game_id, inviter_user_id, guest_display_name, kind,
      membership_priority, state, idempotency_key, confirmed_at
    ) VALUES ($1, $2, $3, 'Гость', 'GUEST', 1, $4, $5, NOW()) RETURNING id`,
    [groupId, gameId, inviterUserId, state, 'notification:guest'],
  );
  return result.rows[0]!.id;
};
