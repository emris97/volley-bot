import {
  asGameTemplateId,
  asGroupId,
  asUserId,
  createGameFromTemplate,
  type GameTemplateSnapshot,
} from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GameCreationDraftRepository } from './game-creation-draft.repository.js';
import { GameRepository } from './game.repository.js';
import { TemplateRepository } from './template.repository.js';

const snapshot: GameTemplateSnapshot = {
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
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
};

describe('GameRepository', () => {
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
    await pool.query(
      'TRUNCATE game_creation_drafts, audit_events, outbox_events, games, game_templates, groups, users CASCADE',
    );
  });

  it('keeps templates tenant-scoped and locks games before changes', async () => {
    const firstGroup = await insertGroup(pool, '-1001', 'First');
    const secondGroup = await insertGroup(pool, '-1002', 'Second');
    const database = createDatabase(pool);
    const templates = new TemplateRepository(database);
    const games = new GameRepository(database);

    const template = await templates.insert({
      groupId: firstGroup,
      ...snapshot,
    });
    expect(await templates.findById(secondGroup, template.id)).toBeNull();

    const game = await games.insert({
      groupId: firstGroup,
      sourceTemplateId: template.id,
      name: snapshot.name,
      venue: snapshot.venue,
      address: snapshot.address,
      startsAt: new Date('2026-09-04T16:00:00.000Z'),
      durationMinutes: snapshot.durationMinutes,
      capacity: snapshot.capacity,
      timeZone: 'Europe/Astrakhan',
      registrationOpensAt: new Date('2026-08-28T16:00:00.000Z'),
      registrationClosesAt: new Date('2026-09-04T15:00:00.000Z'),
      tentativePromptAt: new Date('2026-09-03T16:00:00.000Z'),
      tentativeResponseDeadline: new Date('2026-09-03T17:00:00.000Z'),
      reminderAt: new Date('2026-09-04T14:00:00.000Z'),
      memberPriorityEnabled: true,
      totalCostMinor: null,
      currency: 'RUB',
      roundingMode: 'EXACT',
      state: 'DRAFT',
      revision: 0,
      scheduleRevision: 0,
      canonicalTelegramMessageId: null,
    });

    await expect(
      games.withLockedGame(secondGroup, game.id!, async () => game),
    ).rejects.toThrow(/game not found/i);

    const opened = await games.withLockedGame(
      firstGroup,
      game.id!,
      async (_locked, changes) => changes.updateState('OPEN'),
    );
    expect(opened.state).toBe('OPEN');
  });

  it('publishes one game and one audit/outbox state under concurrent retries', async () => {
    const groupId = await insertGroup(pool, '-1003', 'Atomic');
    const actorUserId = await insertUser(pool, '1003');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draftId = '018f6ba062d27bd18f1312e0c8424611';
    const templateId = asGameTemplateId('30000000-0000-4000-8000-000000000001');
    await drafts.save({
      version: 1,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW',
      templateId,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    });
    const input = {
      groupId,
      actorUserId,
      draftId,
      now: new Date('2026-09-05T15:00:00.000Z'),
    };
    const build = () => ({
      ...createGameFromTemplate(
        snapshot,
        new Date('2026-09-12T16:00:00.000Z'),
        'Europe/Astrakhan',
      ),
      groupId,
      sourceTemplateId: null,
      state: 'SCHEDULED' as const,
    });

    const [first, second] = await Promise.all([
      games.publishDraft(input, build),
      games.publishDraft(input, build),
    ]);
    const repeated = await games.publishDraft(input, build);

    expect(new Set([first.game.id, second.game.id]).size).toBe(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(repeated).toMatchObject({
      game: { id: first.game.id },
      created: false,
    });
    await expect(
      pool.query<{ count: string }>(
        'SELECT count(*) FROM games WHERE group_id = $1',
        [groupId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(
      pool.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE group_id = $1 AND event_type = 'GAME_CREATED'",
        [groupId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(
      pool.query<{ count: string }>(
        "SELECT count(*) FROM outbox_events WHERE group_id = $1 AND event_type = 'GAME_CREATED'",
        [groupId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(drafts.load(groupId, actorUserId)).resolves.toMatchObject({
      step: 'PUBLISHED',
      publishedGameId: first.game.id,
    });
  });

  it('rejects a stale draft id without committing publication state', async () => {
    const groupId = await insertGroup(pool, '-1004', 'Stale');
    const actorUserId = await insertUser(pool, '1004');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    await drafts.save({
      version: 1,
      draftId: '018f6ba062d27bd18f1312e0c8424611',
      groupId,
      actorUserId,
      step: 'PREVIEW',
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    });

    await expect(
      games.publishDraft(
        {
          groupId,
          actorUserId,
          draftId: 'ffffffffffffffffffffffffffffffff',
          now: new Date('2026-09-05T15:00:00.000Z'),
        },
        () => ({
          ...createGameFromTemplate(
            snapshot,
            new Date('2026-09-12T16:00:00.000Z'),
            'Europe/Astrakhan',
          ),
          groupId,
          sourceTemplateId: null,
          state: 'SCHEDULED' as const,
        }),
      ),
    ).rejects.toThrow(/stale/i);
    await expect(pool.query('SELECT id FROM games')).resolves.toMatchObject({
      rowCount: 0,
    });
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

const insertUser = async (pool: Pool, telegramUserId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id',
    [telegramUserId],
  );
  return asUserId(result.rows[0]!.id);
};
