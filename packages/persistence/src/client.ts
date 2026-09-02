import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

export const createDatabase = (pool: Pool): Database =>
  drizzle(pool, { schema });

export const createPostgresPool = (
  connectionString: string,
  max?: number,
): Pool =>
  new Pool({ connectionString, ...(max === undefined ? {} : { max }) });
