import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPostgresPool } from '@volley/persistence';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';

describe('safe PostgreSQL migration runner', () => {
  let container: StartedTestContainer;
  let pool: ReturnType<typeof createPostgresPool>;
  const temporaryDirectories: string[] = [];

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
    pool = createPostgresPool(
      `postgresql://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/volley`,
      4,
    );
  }, 60_000);

  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
  });

  afterAll(async () => {
    await Promise.all(
      temporaryDirectories.map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
    await pool?.end();
    await container?.stop();
  });

  it('journals checksums and skips an identical full rerun', async () => {
    const migrationsDirectory = resolve(
      process.cwd(),
      'packages/persistence/migrations',
    );

    const first = await applyMigrations(pool, migrationsDirectory);
    const firstJournal = await journal();
    const second = await applyMigrations(pool, migrationsDirectory);

    expect(first).toHaveLength(10);
    expect(second).toEqual([]);
    expect(await journal()).toEqual(firstJournal);
    expect(firstJournal).toHaveLength(10);
    expect(
      firstJournal.every(({ checksum }) => /^[a-f\d]{64}$/.test(checksum)),
    ).toBe(true);
  });

  it('serializes concurrent runners with a session advisory lock', async () => {
    const directory = await migrationDirectory({
      '0001_once.sql':
        'CREATE TABLE exactly_once (id integer PRIMARY KEY); SELECT pg_sleep(0.2);',
    });

    const results = await Promise.all([
      applyMigrations(pool, directory),
      applyMigrations(pool, directory),
    ]);

    expect(results.map((result) => result.length).toSorted()).toEqual([0, 1]);
    expect(await journal()).toHaveLength(1);
    expect(
      await pool.query(`SELECT to_regclass('public.exactly_once') AS name`),
    ).toMatchObject({ rows: [{ name: 'exactly_once' }] });
  });

  it('rejects a changed applied migration checksum', async () => {
    const directory = await migrationDirectory({
      '0001_checksum.sql': 'CREATE TABLE checksum_guard (id integer);',
    });
    await applyMigrations(pool, directory);
    await writeFile(
      join(directory, '0001_checksum.sql'),
      'CREATE TABLE checksum_guard_changed (id integer);',
      'utf8',
    );

    await expect(applyMigrations(pool, directory)).rejects.toThrow(
      /checksum mismatch.*0001_checksum/i,
    );
  });

  it('treats platform line endings as the same migration content', async () => {
    const directory = await migrationDirectory({
      '0001_portable.sql':
        'CREATE TABLE portable_checksum (\n  id integer\n);\n',
    });
    await applyMigrations(pool, directory);
    await writeFile(
      join(directory, '0001_portable.sql'),
      'CREATE TABLE portable_checksum (\r\n  id integer\r\n);\r\n',
      'utf8',
    );

    await expect(applyMigrations(pool, directory)).resolves.toEqual([]);
  });

  it('rolls back a failed migration file without journaling it', async () => {
    const directory = await migrationDirectory({
      '0001_broken.sql':
        'CREATE TABLE rolled_back (id integer); SELECT missing_function();',
    });

    await expect(applyMigrations(pool, directory)).rejects.toThrow();

    expect(
      await pool.query(`SELECT to_regclass('public.rolled_back') AS name`),
    ).toMatchObject({ rows: [{ name: null }] });
    expect(await journal()).toEqual([]);
  });

  const migrationDirectory = async (
    files: Record<string, string>,
  ): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'volley-migrations-int-'));
    temporaryDirectories.push(directory);
    await Promise.all(
      Object.entries(files).map(([name, contents]) =>
        writeFile(join(directory, name), contents, 'utf8'),
      ),
    );
    return directory;
  };

  const journal = async (): Promise<
    Array<{ name: string; checksum: string; applied_at: Date }>
  > => {
    const result = await pool.query<{
      name: string;
      checksum: string;
      applied_at: Date;
    }>(
      `SELECT name, checksum, applied_at
       FROM volley_schema_migrations
       ORDER BY name`,
    );
    return result.rows;
  };
});
