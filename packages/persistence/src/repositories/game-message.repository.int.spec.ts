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

  it('renders roster and waitlist in canonical placement-policy order after manual and priority changes', async () => {
    const group = await pool.query<{ id: string }>(
      `INSERT INTO groups (
        telegram_chat_id, title, onboarding_state, time_zone, pin_game_messages
      ) VALUES (-4202, 'Placement', 'CONFIGURED', 'UTC', true) RETURNING id`,
    );
    const groupId = asGroupId(group.rows[0]!.id);
    const game = await pool.query<{ id: string }>(
      `INSERT INTO games (
        group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
        registration_opens_at, registration_closes_at, tentative_prompt_at,
        tentative_response_deadline, reminder_at, member_priority_enabled, state
      ) VALUES (
        $1, 'Game', 'Gym', '2026-09-11T16:00:00.000Z', 120, 4, 'UTC',
        '2026-09-01T16:00:00.000Z', '2026-09-11T15:00:00.000Z',
        '2026-09-11T13:00:00.000Z', '2026-09-11T14:00:00.000Z',
        '2026-09-11T15:00:00.000Z', true, 'OPEN'
      ) RETURNING id`,
      [groupId],
    );
    const gameId = asGameId(game.rows[0]!.id);
    const userRows = await Promise.all(
      [
        'Ручной второй',
        'Ручной первый',
        'Участник',
        'Гость по порядку',
        'Резерв участник',
        'Резерв гость',
      ].map(
        async (displayName, index) =>
          (
            await pool.query<{ id: string }>(
              `INSERT INTO users (telegram_user_id, display_name)
               VALUES ($1, $2) RETURNING id`,
              [(5000 + index).toString(), displayName],
            )
          ).rows[0]!,
      ),
    );
    const registrationIds = [
      '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
      '018f6ba0-62d2-7bd1-8f13-12e0c8424612',
      '018f6ba0-62d2-7bd1-8f13-12e0c8424613',
      '018f6ba0-62d2-7bd1-8f13-12e0c8424614',
      '018f6ba0-62d2-7bd1-8f13-12e0c8424615',
    ];
    const rows = [
      [0, 0, 2, '2026-09-01T09:00:00Z', 'ROSTERED'],
      [1, 0, 0, '2026-09-01T09:05:00Z', 'ROSTERED'],
      [2, 1, null, '2026-09-01T09:10:00Z', 'ROSTERED'],
      [3, 0, null, '2026-09-01T09:01:00Z', 'ROSTERED'],
      [4, 1, null, '2026-09-01T09:20:00Z', 'WAITLISTED'],
      [5, 0, null, '2026-09-01T09:02:00Z', 'WAITLISTED'],
    ] as const;
    for (const [index, priority, manualRank, confirmedAt, state] of rows) {
      await pool.query(
        `INSERT INTO registrations (
          id, group_id, game_id, user_id, kind, membership_priority, state,
          idempotency_key, confirmed_at, manual_rank, created_at
        ) VALUES ($1, $2, $3, $4, 'MEMBER', $5, $6, $7, $8, $9, $10)`,
        [
          registrationIds[index],
          groupId,
          gameId,
          userRows[index]!.id,
          priority,
          state,
          `placement-${index}`,
          confirmedAt,
          manualRank,
          `2026-09-01T08:0${index}:00Z`,
        ],
      );
    }
    const repository = new GameMessageRepository(createDatabase(pool), pool);

    await expect(repository.load(groupId, gameId)).resolves.toMatchObject({
      roster: [
        'Ручной первый',
        'Ручной второй',
        'Участник',
        'Гость по порядку',
      ],
      waitlist: ['Резерв участник', 'Резерв гость'],
    });

    await pool.query(
      'UPDATE games SET member_priority_enabled = false WHERE id = $1',
      [gameId],
    );
    await expect(repository.load(groupId, gameId)).resolves.toMatchObject({
      roster: [
        'Ручной первый',
        'Ручной второй',
        'Гость по порядку',
        'Участник',
      ],
      waitlist: ['Резерв гость', 'Резерв участник'],
    });
    await pool.query(
      'UPDATE games SET member_priority_enabled = true WHERE id = $1',
      [gameId],
    );

    await pool.query(
      `UPDATE registrations
       SET manual_rank = CASE WHEN id = $1 THEN 0 ELSE NULL END,
           membership_priority = CASE WHEN id = $2 THEN 1 ELSE membership_priority END,
           state = CASE
             WHEN id = $2 THEN 'ROSTERED'
             WHEN id = $4 THEN 'WAITLISTED'
             ELSE state
           END
       WHERE game_id = $3`,
      [registrationIds[3], registrationIds[5], gameId, registrationIds[1]],
    );
    await expect(repository.load(groupId, gameId)).resolves.toMatchObject({
      roster: ['Гость по порядку', 'Резерв гость', 'Участник', 'Ручной второй'],
    });
  });
});
