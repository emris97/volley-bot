import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresPool } from '@volley/persistence';

export interface MigrationDatabase {
  query(sql: string): Promise<unknown>;
}

const defaultMigrationsDirectory = resolve(
  process.cwd(),
  'packages/persistence/migrations',
);

export const applyMigrations = async (
  database: MigrationDatabase,
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<string[]> => {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await database.query(
      await readFile(resolve(migrationsDirectory, file), 'utf8'),
    );
  }
  return files;
};

export const runMigrations = async (
  input: {
    databaseUrl?: string;
    migrationsDirectory?: string;
  } = {},
): Promise<string[]> => {
  const databaseUrl = input.databaseUrl ?? process.env.DATABASE_URL;
  if (
    databaseUrl === undefined ||
    (!databaseUrl.startsWith('postgresql://') &&
      !databaseUrl.startsWith('postgres://'))
  ) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  const pool = createPostgresPool(databaseUrl, 1);
  try {
    return await applyMigrations(
      pool,
      input.migrationsDirectory ?? defaultMigrationsDirectory,
    );
  } finally {
    await pool.end();
  }
};

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  void runMigrations()
    .then((files) => {
      process.stdout.write(
        `${JSON.stringify({
          level: 'info',
          message: 'database migrations complete',
          migrationFiles: files.length,
        })}\n`,
      );
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({
          level: 'fatal',
          message: 'database migration failed',
        })}\n`,
      );
      process.exitCode = 1;
    });
}
