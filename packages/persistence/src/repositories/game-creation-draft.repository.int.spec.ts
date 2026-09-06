import type { GameCreationDraft } from '@volley/application';
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

beforeEach(async () => {
  await pool.query('TRUNCATE game_creation_drafts, groups, users CASCADE');
});

it('round-trips a strict versioned draft and its copied bigint snapshot', async () => {
  const { groupId, actorUserId } = await identities('-3001', '301');
  const repository = new GameCreationDraftRepository(createDatabase(pool));
  const draft: GameCreationDraft = {
    version: 1,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    groupId,
    actorUserId,
    step: 'PREVIEW',
    templateId: asGameTemplateId('30000000-0000-4000-8000-000000000001'),
    snapshot: {
      name: 'Friday volleyball',
      venue: 'Arena',
      address: null,
      startsAtLocalTime: '20:00',
      durationMinutes: 120,
      capacity: 12,
      registrationOpensMinutesBefore: 10_080,
      registrationClosesMinutesBefore: 60,
      tentativePromptMinutesBefore: 1_440,
      tentativeResponseMinutes: 60,
      reminderMinutesBefore: 120,
      memberPriorityEnabled: true,
      defaultTotalCostMinor: 125_050n,
      currency: 'RUB',
      roundingMode: 'UP_10',
    },
    startsAtIso: '2026-09-12T16:00:00.000Z',
    previewed: true,
  };

  await repository.save(draft);

  const restarted = new GameCreationDraftRepository(createDatabase(pool));
  await expect(restarted.load(groupId, actorUserId)).resolves.toEqual(draft);
});

it('rejects unknown persisted draft keys', async () => {
  const { groupId, actorUserId } = await identities('-3002', '302');
  await insertData(groupId, actorUserId, {
    version: 1,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    step: 'TEMPLATE',
    previewed: false,
    surprise: true,
  });
  const repository = new GameCreationDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /unknown draft key/i,
  );
});

it('rejects unsupported persisted versions', async () => {
  const { groupId, actorUserId } = await identities('-3003', '303');
  await insertData(groupId, actorUserId, {
    version: 2,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    step: 'TEMPLATE',
    previewed: false,
  });
  const repository = new GameCreationDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /unsupported draft version/i,
  );
});

it('rejects incomplete persisted snapshots', async () => {
  const { groupId, actorUserId } = await identities('-3004', '304');
  await insertData(groupId, actorUserId, {
    version: 1,
    draftId: '018f6ba062d27bd18f1312e0c8424611',
    step: 'PREVIEW',
    snapshot: { name: 'Incomplete' },
    startsAtIso: '2026-09-12T16:00:00.000Z',
    previewed: true,
  });
  const repository = new GameCreationDraftRepository(createDatabase(pool));

  await expect(repository.load(groupId, actorUserId)).rejects.toThrow(
    /snapshot/i,
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

const insertData = async (
  groupId: ReturnType<typeof asGroupId>,
  actorUserId: ReturnType<typeof asUserId>,
  data: Record<string, unknown>,
): Promise<void> => {
  await pool.query(
    'INSERT INTO game_creation_drafts (group_id, actor_user_id, data) VALUES ($1, $2, $3)',
    [groupId, actorUserId, data],
  );
};
