import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { applyMigrations } from './migration-runner.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);

export const applyTestMigrations = async (pool: Pool): Promise<void> => {
  await applyMigrations(pool, fileURLToPath(migrationsUrl));
};
