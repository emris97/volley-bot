import { asGameTemplateId, asGroupId, asUserId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { TemplateWizardDraftRepository } from './template-wizard-draft.repository.js';

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

beforeEach(async () => {
  await pool.query('TRUNCATE template_wizard_drafts, groups, users CASCADE');
});

it('upserts and strictly revives a bigint draft through a fresh instance', async () => {
  const { groupId, actorUserId } = await identities('-5101', '511');
  const first = new TemplateWizardDraftRepository(createDatabase(pool));
  await first.save(groupId, actorUserId, {
    version: 1,
    mode: 'EDIT',
    step: 'PREVIEW',
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    viewRevision: 7,
    templateId: asGameTemplateId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
    expectedRevision: 3,
    snapshot: { name: 'Среда', defaultTotalCostMinor: 125050n },
    previewed: true,
  });
  await first.save(groupId, actorUserId, {
    version: 1,
    mode: 'EDIT',
    step: 'CAPACITY',
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    viewRevision: 8,
    templateId: asGameTemplateId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
    expectedRevision: 3,
    snapshot: { name: 'Среда', defaultTotalCostMinor: 130000n },
    previewed: false,
  });

  const restarted = new TemplateWizardDraftRepository(createDatabase(pool));
  expect(await restarted.load(groupId, actorUserId)).toMatchObject({
    mode: 'EDIT',
    step: 'CAPACITY',
    viewRevision: 8,
    expectedRevision: 3,
    snapshot: { name: 'Среда', defaultTotalCostMinor: 130000n },
    previewed: false,
  });
});

it('clears only the requested actor within the requested tenant', async () => {
  const first = await identities('-5102', '512');
  const second = await identities('-5103', '513');
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));
  const draft = {
    version: 1 as const,
    mode: 'CREATE' as const,
    step: 'NAME' as const,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    viewRevision: 0,
    snapshot: {},
    previewed: false,
  };
  await repository.save(first.groupId, first.actorUserId, draft);
  await repository.save(second.groupId, second.actorUserId, draft);

  await repository.clear(first.groupId, first.actorUserId);

  expect(await repository.load(first.groupId, first.actorUserId)).toBeNull();
  expect(await repository.load(second.groupId, second.actorUserId)).toEqual(
    draft,
  );
});

it('rejects unknown persisted draft keys', async () => {
  const { groupId, actorUserId } = await identities('-5104', '514');
  await pool.query(
    'INSERT INTO template_wizard_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [groupId, actorUserId, { version: 1, surprise: true }],
  );
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /unknown draft key/i,
  );
});

it('rejects unsupported persisted draft versions', async () => {
  const { groupId, actorUserId } = await identities('-5105', '515');
  await pool.query(
    'INSERT INTO template_wizard_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [groupId, actorUserId, { version: 2 }],
  );
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /unsupported draft version/i,
  );
});

it('rejects an array where the persisted snapshot must be an object', async () => {
  const { groupId, actorUserId } = await identities('-5106', '516');
  await pool.query(
    'INSERT INTO template_wizard_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [
      groupId,
      actorUserId,
      {
        version: 1,
        mode: 'CREATE',
        step: 'NAME',
        draftId: '018f6ba062d27bd18f1312e0c8424611',
        viewRevision: 0,
        snapshot: [],
        previewed: false,
      },
    ],
  );
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /invalid draft snapshot/i,
  );
});

it('revives a legacy version-1 draft without a persisted view revision at revision zero', async () => {
  const { groupId, actorUserId } = await identities('-5107', '517');
  await pool.query(
    'INSERT INTO template_wizard_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [
      groupId,
      actorUserId,
      {
        version: 1,
        mode: 'CREATE',
        step: 'NAME',
        draftId: '018f6ba062d27bd18f1312e0c8424611',
        snapshot: {},
        previewed: false,
      },
    ],
  );
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).resolves.toMatchObject({
    viewRevision: 0,
  });
});

it('rejects a supplied invalid persisted view revision', async () => {
  const { groupId, actorUserId } = await identities('-5108', '518');
  await pool.query(
    'INSERT INTO template_wizard_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [
      groupId,
      actorUserId,
      {
        version: 1,
        mode: 'CREATE',
        step: 'NAME',
        draftId: '018f6ba062d27bd18f1312e0c8424611',
        viewRevision: -1,
        snapshot: {},
        previewed: false,
      },
    ],
  );
  const repository = new TemplateWizardDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /view revision/i,
  );
});

const identities = async (telegramChatId: string, telegramUserId: string) => {
  const group = await pool.query<{ id: string }>(
    'INSERT INTO groups (telegram_chat_id, title) VALUES ($1, $2) RETURNING id',
    [telegramChatId, 'Group'],
  );
  const user = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id',
    [telegramUserId],
  );
  return {
    groupId: asGroupId(group.rows[0]!.id),
    actorUserId: asUserId(user.rows[0]!.id),
  };
};
