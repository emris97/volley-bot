import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface MigrationClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export interface MigrationDatabase {
  connect(): Promise<MigrationClient>;
}

export const applyMigrations = async (
  database: MigrationDatabase,
  migrationsDirectory: string,
): Promise<string[]> => {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const sql = await readFile(resolve(migrationsDirectory, file), 'utf8');
      return {
        file,
        name: file.slice(0, -'.sql'.length),
        sql,
        checksum: createHash('sha256')
          .update(sql.replaceAll('\r\n', '\n'))
          .digest('hex'),
      };
    }),
  );
  const client = await database.connect();
  let locked = false;
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [
      'volley-bot:schema-migrations',
    ]);
    locked = true;
    await ensureJournal(client);

    for (const migration of migrations) {
      const result = await client.query<{ checksum: string | null }>(
        `SELECT checksum
         FROM volley_schema_migrations
         WHERE name = $1`,
        [migration.name],
      );
      const recorded = result.rows[0];
      if (recorded !== undefined) {
        if (recorded.checksum === null) {
          await client.query(
            `UPDATE volley_schema_migrations
             SET checksum = $2
             WHERE name = $1 AND checksum IS NULL`,
            [migration.name, migration.checksum],
          );
          continue;
        }
        if (recorded.checksum !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.name}`);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO volley_schema_migrations (name, checksum)
           VALUES ($1, $2)`,
          [migration.name, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } finally {
    try {
      if (locked) {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          'volley-bot:schema-migrations',
        ]);
      }
    } finally {
      client.release();
    }
  }
};

const ensureJournal = async (client: MigrationClient): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS volley_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE volley_schema_migrations
      ADD COLUMN IF NOT EXISTS checksum TEXT
  `);
};
