import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asUserId,
} from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { AttendanceRepository } from './attendance.repository.js';

describe('AttendanceRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repository: AttendanceRepository;

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
    repository = new AttendanceRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE outbox_events, audit_events, attendance_entries, attendance_snapshots, registrations, games, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('persists immutable finalized attendance and tenant-scoped correction snapshots', async () => {
    const groupId = await insertGroup(pool, '-1001');
    const otherGroupId = await insertGroup(pool, '-1002');
    const actorUserId = await insertUser(pool, '42', 'Organizer');
    const completedGameId = await insertGame(pool, groupId, 'COMPLETED');
    const openGameId = await insertGame(pool, groupId, 'OPEN');
    const registrationId = await insertRosteredRegistration(
      pool,
      groupId,
      completedGameId,
      actorUserId,
    );

    const preview = await repository.confirm({
      groupId,
      gameId: completedGameId,
      actorUserId,
      expectedRevision: 0,
      excludedRegistrationIds: [registrationId],
      manualParticipants: [{ displayName: 'Late player', billable: true }],
      finalize: false,
    });
    expect(preview.entries).not.toContainEqual(
      expect.objectContaining({ sourceRegistrationId: registrationId }),
    );
    expect(preview.rosterCandidates).toContainEqual(
      expect.objectContaining({
        sourceRegistrationId: registrationId,
        included: false,
      }),
    );
    const laterRegistrationId = await insertRosteredRegistration(
      pool,
      groupId,
      completedGameId,
      await insertUser(pool, '43', 'Later player'),
      'later',
    );
    const independentlyRead = await repository.findSnapshot(
      groupId,
      preview.id,
    );
    expect(independentlyRead?.rosterCandidates).toEqual(
      preview.rosterCandidates,
    );
    expect(independentlyRead?.rosterCandidates).not.toContainEqual(
      expect.objectContaining({ sourceRegistrationId: laterRegistrationId }),
    );

    const stale = await repository.confirm({
      groupId,
      gameId: completedGameId,
      actorUserId,
      expectedRevision: 0,
      excludedRegistrationIds: [],
      manualParticipants: [],
      finalize: false,
    });
    expect(stale).toEqual(preview);

    const finalized = await repository.confirm({
      groupId,
      gameId: completedGameId,
      actorUserId,
      expectedRevision: preview.revision,
      excludedRegistrationIds: [registrationId],
      manualParticipants: [{ displayName: 'Late player', billable: true }],
      finalize: true,
    });
    const afterFinalization = await repository.confirm({
      groupId,
      gameId: completedGameId,
      actorUserId,
      expectedRevision: finalized.revision,
      excludedRegistrationIds: [],
      manualParticipants: [],
      finalize: false,
    });
    expect(afterFinalization).toEqual(finalized);

    await expect(
      repository.confirm({
        groupId: otherGroupId,
        gameId: completedGameId,
        actorUserId,
        expectedRevision: 0,
        excludedRegistrationIds: [],
        manualParticipants: [],
        finalize: false,
      }),
    ).rejects.toThrow(/game not found/i);
    await expect(
      repository.confirm({
        groupId,
        gameId: openGameId,
        actorUserId,
        expectedRevision: 0,
        excludedRegistrationIds: [],
        manualParticipants: [],
        finalize: false,
      }),
    ).rejects.toThrow(/game must be completed/i);

    await expect(
      pool.query('SELECT * FROM attendance_snapshots'),
    ).resolves.toMatchObject({ rowCount: 2 });
    await expect(
      pool.query('SELECT * FROM attendance_entries'),
    ).resolves.toMatchObject({ rowCount: 2 });
    await expect(
      pool.query('SELECT * FROM audit_events'),
    ).resolves.toMatchObject({ rowCount: 2 });
    await expect(
      pool.query('SELECT * FROM outbox_events'),
    ).resolves.toMatchObject({ rowCount: 2 });
  });
});

const insertGroup = async (pool: Pool, telegramChatId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO groups (telegram_chat_id, title) VALUES ($1, $2) RETURNING id',
    [telegramChatId, telegramChatId],
  );
  return asGroupId(result.rows[0]!.id);
};

const insertUser = async (
  pool: Pool,
  telegramUserId: string,
  displayName: string,
) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id',
    [telegramUserId, displayName],
  );
  return asUserId(result.rows[0]!.id);
};

const insertGame = async (
  pool: Pool,
  groupId: ReturnType<typeof asGroupId>,
  state: 'COMPLETED' | 'OPEN',
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, tentative_prompt_at, tentative_response_deadline,
      reminder_at, member_priority_enabled, state
    ) VALUES ($1, 'Friday volleyball', 'Arena', NOW(), 120, 12, 'UTC',
      NOW(), NOW(), NOW(), NOW(), TRUE, $2) RETURNING id`,
    [groupId, state],
  );
  return asGameId(result.rows[0]!.id);
};

const insertRosteredRegistration = async (
  pool: Pool,
  groupId: ReturnType<typeof asGroupId>,
  gameId: ReturnType<typeof asGameId>,
  userId: ReturnType<typeof asUserId>,
  suffix = 'initial',
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO registrations (
      group_id, game_id, user_id, kind, membership_priority, state,
      idempotency_key, confirmed_at
    ) VALUES ($1, $2, $3, 'MEMBER', 1, 'ROSTERED', $4, NOW()) RETURNING id`,
    [groupId, gameId, userId, `attendance:${gameId}:${suffix}`],
  );
  return asRegistrationId(result.rows[0]!.id);
};
