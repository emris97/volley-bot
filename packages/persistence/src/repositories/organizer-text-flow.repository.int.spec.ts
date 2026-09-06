import { asGroupId, asTelegramId, asUserId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { OrganizerTextFlowRepository } from './organizer-text-flow.repository.js';

describe('OrganizerTextFlowRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repository: OrganizerTextFlowRepository;
  const telegramId = asTelegramId('420000001');

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
    repository = new OrganizerTextFlowRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users, groups CASCADE');
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('keeps only the latest claimed text flow while preserving its reference', async () => {
    const first = await seedActor(pool, telegramId, '-100420000001');

    await repository.claim({
      ...first,
      kind: 'PAYMENT',
      reference: 'game-1',
    });
    await repository.claim({
      ...first,
      kind: 'TEMPLATE',
      reference: 'draft-2',
    });

    expect(await repository.current(telegramId)).toMatchObject({
      ...first,
      kind: 'TEMPLATE',
      reference: 'draft-2',
    });

    repository = new OrganizerTextFlowRepository(createDatabase(pool));
    await repository.claim({
      ...first,
      kind: 'PAYMENT',
      reference: 'game-3',
    });
    expect(await repository.current(telegramId)).toMatchObject({
      ...first,
      kind: 'PAYMENT',
      reference: 'game-3',
    });
  });

  it('survives repository recreation and refuses a cross-tenant or wrong-flow release', async () => {
    const first = await seedActor(pool, telegramId, '-100420000002');
    const other = await seedActor(
      pool,
      asTelegramId('420000002'),
      '-100420000003',
    );
    await repository.claim({
      ...first,
      kind: 'ATTENDANCE',
      reference: 'snapshot-1',
    });

    repository = new OrganizerTextFlowRepository(createDatabase(pool));
    await expect(
      repository.release({
        ...other,
        actorUserId: first.actorUserId,
        kind: 'ATTENDANCE',
      }),
    ).resolves.toBe(false);
    await expect(
      repository.release({ ...first, kind: 'PAYMENT' }),
    ).resolves.toBe(false);
    expect(await repository.current(telegramId)).toMatchObject({
      ...first,
      kind: 'ATTENDANCE',
      reference: 'snapshot-1',
    });
    await expect(
      repository.release({ ...first, kind: 'ATTENDANCE' }),
    ).resolves.toBe(true);
    await expect(repository.current(telegramId)).resolves.toBeNull();
  });
});

const seedActor = async (
  pool: Pool,
  telegramId: ReturnType<typeof asTelegramId>,
  chatId: string,
): Promise<{
  groupId: ReturnType<typeof asGroupId>;
  actorUserId: ReturnType<typeof asUserId>;
}> => {
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, display_name)
     VALUES ($1, 'Организатор') RETURNING id`,
    [telegramId],
  );
  const group = await pool.query<{ id: string }>(
    `INSERT INTO groups (telegram_chat_id, title)
     VALUES ($1, 'Группа') RETURNING id`,
    [chatId],
  );
  return {
    groupId: asGroupId(group.rows[0]!.id),
    actorUserId: asUserId(user.rows[0]!.id),
  };
};
