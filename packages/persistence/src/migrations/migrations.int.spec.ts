import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTestMigrations } from './migration-test-helper.js';

describe('foundation migration', () => {
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
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('applies to an empty database and is a no-op when repeated', async () => {
    await applyTestMigrations(pool);

    const firstTables = await applicationTables(pool);
    const firstMigration = await appliedFoundationMigration(pool);

    await applyTestMigrations(pool);

    expect(await applicationTables(pool)).toEqual(firstTables);
    expect(await appliedFoundationMigration(pool)).toEqual(firstMigration);
    expect(firstTables).toEqual([
      'attendance_entries',
      'attendance_snapshots',
      'audit_events',
      'charge_status_events',
      'game_creation_drafts',
      'game_templates',
      'games',
      'group_members',
      'groups',
      'guest_registration_drafts',
      'notification_deliveries',
      'organizer_preferences',
      'outbox_events',
      'payment_drafts',
      'payment_input_sessions',
      'payment_reminder_deliveries',
      'payment_reminder_requests',
      'registrations',
      'scheduled_jobs',
      'settlement_charges',
      'settlements',
      'template_wizard_drafts',
      'users',
      'volley_schema_migrations',
    ]);
    expect(firstTables).toContain('organizer_preferences');
    expect(firstTables).toContain('template_wizard_drafts');
    expect(firstMigration).toHaveLength(1);
  });

  it('adds organizer-management revisions and active template name uniqueness', async () => {
    await applyTestMigrations(pool);
    const groupId = await insertGroup(pool);

    await insertTemplate(pool, groupId, 'Среда');
    const templateRevision = await pool.query<{ revision: number }>(
      'SELECT revision FROM game_templates WHERE group_id = $1',
      [groupId],
    );
    expect(templateRevision.rows).toEqual([{ revision: 0 }]);

    const gameRevision = await pool.query<{ revision: number }>(
      `INSERT INTO games (
        group_id, name, venue, starts_at, duration_minutes, capacity,
        time_zone, registration_opens_at, tentative_prompt_at,
        tentative_response_deadline, reminder_at, member_priority_enabled,
        currency, rounding_mode
      ) VALUES (
        $1, 'Среда', 'Зал', '2026-09-09T16:00:00.000Z', 120, 14,
        'Europe/Astrakhan', '2026-09-08T16:00:00.000Z',
        '2026-09-09T12:00:00.000Z', '2026-09-09T13:00:00.000Z',
        '2026-09-09T14:00:00.000Z', true, 'RUB', 'EXACT'
      ) RETURNING revision`,
      [groupId],
    );
    expect(gameRevision.rows).toEqual([{ revision: 0 }]);

    await expect(insertTemplate(pool, groupId, ' среда ')).rejects.toMatchObject({
      code: '23505',
    });
  });
});

const insertGroup = async (pool: Pool): Promise<string> => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO groups (telegram_chat_id, title)
     VALUES ('-1001000000001', 'Organizer management')
     RETURNING id`,
  );
  return result.rows[0]!.id;
};

const insertTemplate = async (
  pool: Pool,
  groupId: string,
  name: string,
): Promise<void> => {
  await pool.query(
    `INSERT INTO game_templates (
      group_id, name, venue, starts_at_local_time, duration_minutes, capacity,
      registration_opens_minutes_before, tentative_prompt_minutes_before,
      tentative_response_minutes, reminder_minutes_before,
      member_priority_enabled, currency, rounding_mode
    ) VALUES ($1, $2, 'Зал', '19:00', 120, 14, 1440, 720, 60, 120, true, 'RUB', 'EXACT')`,
    [groupId, name],
  );
};

const applicationTables = async (pool: Pool): Promise<string[]> => {
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  return result.rows.map((row) => row.table_name);
};

const appliedFoundationMigration = async (
  pool: Pool,
): Promise<Array<{ name: string; appliedAt: Date }>> => {
  const result = await pool.query<{ name: string; applied_at: Date }>(`
    SELECT name, applied_at
    FROM volley_schema_migrations
    WHERE name = '0001_foundation'
  `);
  return result.rows.map((row) => ({
    name: row.name,
    appliedAt: row.applied_at,
  }));
};
