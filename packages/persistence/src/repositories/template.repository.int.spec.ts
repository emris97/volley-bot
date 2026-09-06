import { asGroupId, type GameTemplateSnapshot } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { TemplateRepository } from './template.repository.js';

const snapshot = (name: string): GameTemplateSnapshot => ({
  name,
  venue: 'Arena',
  address: null,
  startsAtLocalTime: '19:30',
  durationMinutes: 120,
  capacity: 12,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
});

describe('TemplateRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repository: TemplateRepository;
  let groupId: ReturnType<typeof asGroupId>;
  let anotherGroupId: ReturnType<typeof asGroupId>;

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
    repository = new TemplateRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE game_templates, groups CASCADE');
    groupId = await insertGroup(pool, '-1001000000001', 'First');
    anotherGroupId = await insertGroup(pool, '-1001000000002', 'Second');
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('lists only active templates in normalized-name order with a cursor', async () => {
    await repository.insert({ groupId, ...snapshot('Bravo') });
    await repository.insert({ groupId, ...snapshot('alpha') });
    const archived = await repository.insert({
      groupId,
      ...snapshot('Charlie'),
    });
    await repository.insert({ groupId, ...snapshot('Delta') });
    await repository.setArchived({
      groupId,
      templateId: archived.id,
      expectedRevision: 0,
      archived: true,
    });

    const first = await repository.list(groupId, {
      archived: false,
      limit: 2,
      afterId: null,
    });
    expect(first.items.map((item) => item.name)).toEqual(['alpha', 'Bravo']);
    expect(first.nextCursor).toBe(first.items[1]!.id);

    await expect(
      repository.list(groupId, {
        archived: false,
        limit: 2,
        afterId: first.nextCursor!,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'Delta' })],
      nextCursor: null,
    });
    await expect(
      repository.list(groupId, { archived: true, limit: 8 }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: archived.id })],
    });
  });

  it('updates only a current tenant-scoped revision', async () => {
    const created = await repository.insert({ groupId, ...snapshot('Friday') });

    await expect(
      repository.update({
        groupId,
        templateId: created.id,
        expectedRevision: 0,
        snapshot: snapshot('Saturday'),
      }),
    ).resolves.toMatchObject({ name: 'Saturday', revision: 1 });
    await expect(
      repository.update({
        groupId,
        templateId: created.id,
        expectedRevision: 0,
        snapshot: snapshot('Sunday'),
      }),
    ).resolves.toBeNull();
    await expect(
      repository.update({
        groupId: anotherGroupId,
        templateId: created.id,
        expectedRevision: 1,
        snapshot: snapshot('Sunday'),
      }),
    ).resolves.toBeNull();
  });

  it('persists the PostgreSQL integer maximum for every offset', async () => {
    const maximum = 2_147_483_647;

    await expect(
      repository.insert({
        groupId,
        ...snapshot('Maximum offsets'),
        registrationOpensMinutesBefore: maximum,
        registrationClosesMinutesBefore: maximum,
        tentativePromptMinutesBefore: maximum,
        tentativeResponseMinutes: maximum,
        reminderMinutesBefore: maximum,
      }),
    ).resolves.toMatchObject({
      registrationOpensMinutesBefore: maximum,
      registrationClosesMinutesBefore: maximum,
      tentativePromptMinutesBefore: maximum,
      tentativeResponseMinutes: maximum,
      reminderMinutesBefore: maximum,
    });
  });

  it('maps normalized active-name conflicts during updates and restore', async () => {
    const archived = await repository.insert({
      groupId,
      ...snapshot(' Friday '),
    });
    const active = await repository.insert({
      groupId,
      ...snapshot('Saturday'),
    });

    await expect(
      repository.update({
        groupId,
        templateId: active.id,
        expectedRevision: 0,
        snapshot: snapshot('friday'),
      }),
    ).rejects.toMatchObject({ name: 'TemplateNameConflictError' });
    const archivedVersion = await repository.setArchived({
      groupId,
      templateId: archived.id,
      expectedRevision: 0,
      archived: true,
    });
    await repository.insert({ groupId, ...snapshot('FRIDAY') });

    await expect(
      repository.setArchived({
        groupId,
        templateId: archived.id,
        expectedRevision: archivedVersion!.revision,
        archived: false,
      }),
    ).rejects.toMatchObject({ name: 'TemplateNameConflictError' });
  });
});

const insertGroup = async (
  pool: Pool,
  telegramChatId: string,
  title: string,
) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO groups (telegram_chat_id, title) VALUES ($1, $2) RETURNING id',
    [telegramChatId, title],
  );
  return asGroupId(result.rows[0]!.id);
};
