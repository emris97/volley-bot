import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations } from './migrate.js';

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true });
  directory = undefined;
});

it('applies only SQL migrations in deterministic filename order', async () => {
  directory = await mkdtemp(join(tmpdir(), 'volley-migrations-'));
  await Promise.all([
    writeFile(join(directory, '0002_second.sql'), 'SELECT 2;', 'utf8'),
    writeFile(join(directory, '0001_first.sql'), 'SELECT 1;', 'utf8'),
    writeFile(join(directory, 'notes.md'), 'not a migration', 'utf8'),
  ]);
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let released = false;
  let connectCalls = 0;
  const client = {
    query: async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };

  const applied = await applyMigrations(
    {
      connect: async () => {
        connectCalls += 1;
        return client;
      },
    },
    directory,
  );

  expect(applied).toEqual(['0001_first.sql', '0002_second.sql']);
  expect(connectCalls).toBe(1);
  expect(released).toBe(true);
  expect(queries.map(({ sql }) => sql)).toEqual(
    expect.arrayContaining(['SELECT 1;', 'SELECT 2;']),
  );
  expect(queries.findIndex(({ sql }) => sql === 'SELECT 1;')).toBeLessThan(
    queries.findIndex(({ sql }) => sql === 'SELECT 2;'),
  );
  expect(queries.some(({ sql }) => /pg_advisory_lock/.test(sql))).toBe(true);
  expect(queries.some(({ sql }) => /pg_advisory_unlock/.test(sql))).toBe(true);
});
