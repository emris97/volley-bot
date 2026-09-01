import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const migrationsUrl = new URL('../../migrations/', import.meta.url);

export const applyTestMigrations = async (pool: Pool): Promise<void> => {
  const files = (await readdir(migrationsUrl))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await pool.query(await readFile(new URL(file, migrationsUrl), 'utf8'));
  }
};
