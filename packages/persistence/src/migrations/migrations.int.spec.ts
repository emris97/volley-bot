import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../migrations/0001_foundation.sql',
  import.meta.url,
);

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
    const sql = await readFile(migrationUrl, 'utf8');
    await pool.query(sql);

    const firstTables = await applicationTables(pool);
    const firstMigration = await appliedFoundationMigration(pool);

    await pool.query(sql);

    expect(await applicationTables(pool)).toEqual(firstTables);
    expect(await appliedFoundationMigration(pool)).toEqual(firstMigration);
    expect(firstTables).toEqual([
      'audit_events',
      'group_members',
      'groups',
      'outbox_events',
      'users',
      'volley_schema_migrations',
    ]);
    expect(firstMigration).toHaveLength(1);
  });
});

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
