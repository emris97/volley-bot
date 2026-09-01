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
  const queries: string[] = [];

  const applied = await applyMigrations(
    { query: async (sql: string) => void queries.push(sql) },
    directory,
  );

  expect(applied).toEqual(['0001_first.sql', '0002_second.sql']);
  expect(queries).toEqual(['SELECT 1;', 'SELECT 2;']);
});
