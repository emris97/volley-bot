import { asGroupId, asUserId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GameCreationDraftRepository } from './game-creation-draft.repository.js';

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
  await applyTestMigrations(pool);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

it('loads a draft through a fresh repository instance', async () => {
  const group = await pool.query<{ id: string }>(
    "INSERT INTO groups (telegram_chat_id, title) VALUES ('-3001', 'Group') RETURNING id",
  );
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (telegram_user_id) VALUES ('301') RETURNING id",
  );
  const groupId = asGroupId(group.rows[0]!.id);
  const actorUserId = asUserId(user.rows[0]!.id);
  const first = new GameCreationDraftRepository(createDatabase(pool));
  await first.save({
    groupId,
    actorUserId,
    startsAtIso: '2026-09-12T16:00:00.000Z',
    previewed: false,
  });

  const restarted = new GameCreationDraftRepository(createDatabase(pool));
  expect(await restarted.load(groupId, actorUserId)).toMatchObject({
    groupId,
    actorUserId,
    startsAtIso: '2026-09-12T16:00:00.000Z',
    previewed: false,
  });
});
