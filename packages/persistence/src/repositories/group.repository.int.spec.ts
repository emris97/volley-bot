import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asTelegramId } from '@volley/domain';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GroupRepository } from './group.repository.js';

describe('GroupRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repo: GroupRepository;

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
    repo = new GroupRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('isolates memberships by group', async () => {
    const userTelegramId = asTelegramId('42');
    const first = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000001'),
      title: 'First',
    });
    const second = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000002'),
      title: 'Second',
    });
    await repo.upsertMembership(first.id, userTelegramId, 'ADMIN');

    expect(await repo.findMembership(first.id, userTelegramId)).toMatchObject({
      role: 'ADMIN',
    });
    expect(await repo.findMembership(second.id, userTelegramId)).toBeNull();
  });
});
