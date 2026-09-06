import {
  asGameTemplateId,
  asGroupId,
  asUserId,
  createGameFromTemplate,
  type GameTemplateSnapshot,
} from '@volley/domain';
import { Pool, type PoolClient } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import {
  GameCreationDraftRepository,
  serializeGameCreationDraftData,
} from './game-creation-draft.repository.js';
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
    const draft = {
      version: 1,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW',
      templateId,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    } as const;
    await seedDraft(drafts, draft);
    const input = {
      groupId,
      actorUserId,
      draftId,
      expectedStep: 'PREVIEW' as const,
      expectedViewRevision: 0,
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

  it('refuses a stale mutation waiting behind publication and keeps retries idempotent', async () => {
    const groupId = await insertGroup(pool, '-1005', 'Mutation race');
    const actorUserId = await insertUser(pool, '1005');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draftId = '018f6ba062d27bd18f1312e0c8424611';
    const originalDraft = {
      version: 1 as const,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW' as const,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    };
    await seedDraft(drafts, originalDraft);
    const input = {
      groupId,
      actorUserId,
      draftId,
      expectedStep: 'PREVIEW' as const,
      expectedViewRevision: 0,
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
    const blocker = await pool.connect();
    let lockHeld = false;
    let publication: ReturnType<typeof games.publishDraft> | undefined;

    await installGameInsertBlocker(pool);
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [610_006]);
      lockHeld = true;
      publication = games.publishDraft(input, build);
      await waitForBlockedQuery(pool, 'insert into "games"');

      const staleMutation = drafts.compareAndSet({
        ...originalDraft,
        step: 'CUSTOMIZE',
        snapshot: { ...snapshot, capacity: 99 },
        previewed: false,
      });
      await waitForBlockedQuery(pool, 'update "game_creation_drafts"');

      await blocker.query('SELECT pg_advisory_unlock($1)', [610_006]);
      lockHeld = false;
      const [published, mutationResult] = await Promise.all([
        publication,
        staleMutation,
      ]);
      const repeated = await games.publishDraft(input, build);

      expect(mutationResult).toBe('STALE');
      expect(repeated).toMatchObject({
        game: { id: published.game.id },
        created: false,
      });
      await expect(drafts.load(groupId, actorUserId)).resolves.toMatchObject({
        step: 'PUBLISHED',
        snapshot: { capacity: 12 },
        publishedGameId: published.game.id,
      });
      await expect(
        pool.query<{ count: string }>(
          'SELECT count(*) FROM games WHERE group_id = $1',
          [groupId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    } finally {
      if (lockHeld) {
        await blocker.query('SELECT pg_advisory_unlock($1)', [610_006]);
      }
      await publication?.catch(() => undefined);
      blocker.release();
      await removeGameInsertBlocker(pool);
    }
  });

  it('rejects publication when a cancel mutation wins while the publisher waits for the draft lock', async () => {
    const groupId = await insertGroup(pool, '-1006', 'Cancel race');
    const actorUserId = await insertUser(pool, '1006');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draftId = '018f6ba062d27bd18f1312e0c8424611';
    const originalDraft = {
      version: 1 as const,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW' as const,
      viewRevision: 1,
      cancelPending: false,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    };
    await seedDraft(drafts, originalDraft);
    const input = {
      groupId,
      actorUserId,
      draftId,
      expectedStep: 'PREVIEW' as const,
      expectedViewRevision: 1,
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
    const blocker = await pool.connect();
    let transactionOpen = false;
    let publication: ReturnType<typeof games.publishDraft> | undefined;

    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      await blocker.query(
        'SELECT 1 FROM game_creation_drafts WHERE group_id = $1 AND actor_user_id = $2 FOR UPDATE',
        [groupId, actorUserId],
      );
      publication = games.publishDraft(input, build);
      await waitForBlockedQuery(pool, 'from "game_creation_drafts"');
      await blocker.query(
        'UPDATE game_creation_drafts SET data = $3 WHERE group_id = $1 AND actor_user_id = $2',
        [
          groupId,
          actorUserId,
          serializeGameCreationDraftData({
            ...originalDraft,
            viewRevision: 2,
            cancelPending: true,
          }),
        ],
      );
      await blocker.query('COMMIT');
      transactionOpen = false;

      await expect(publication).rejects.toThrow(/stale/i);
      await expect(pool.query('SELECT id FROM games')).resolves.toMatchObject({
        rowCount: 0,
      });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      await publication?.catch(() => undefined);
      blocker.release();
    }
  });

  it('reports a deleted draft race as stale without creating a game', async () => {
    const groupId = await insertGroup(pool, '-1007', 'Delete race');
    const actorUserId = await insertUser(pool, '1007');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draftId = '018f6ba062d27bd18f1312e0c8424611';
    const originalDraft = {
      version: 1 as const,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW' as const,
      viewRevision: 1,
      cancelPending: false,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    };
    await seedDraft(drafts, originalDraft);
    const input = {
      groupId,
      actorUserId,
      draftId,
      expectedStep: 'PREVIEW' as const,
      expectedViewRevision: 1,
      now: new Date('2026-09-05T15:00:00.000Z'),
    };
    const blocker = await pool.connect();
    let transactionOpen = false;
    let publication: ReturnType<typeof games.publishDraft> | undefined;

    try {
      await blocker.query('BEGIN');
      transactionOpen = true;
      await blocker.query(
        'SELECT 1 FROM game_creation_drafts WHERE group_id = $1 AND actor_user_id = $2 FOR UPDATE',
        [groupId, actorUserId],
      );
      publication = games.publishDraft(input, () => ({
        ...createGameFromTemplate(
          snapshot,
          new Date('2026-09-12T16:00:00.000Z'),
          'Europe/Astrakhan',
        ),
        groupId,
        sourceTemplateId: null,
        state: 'SCHEDULED' as const,
      }));
      await waitForBlockedQuery(pool, 'from "game_creation_drafts"');
      await blocker.query(
        'DELETE FROM game_creation_drafts WHERE group_id = $1 AND actor_user_id = $2',
        [groupId, actorUserId],
      );
      await blocker.query('COMMIT');
      transactionOpen = false;

      await expect(publication).rejects.toThrow(/stale/i);
      await expect(pool.query('SELECT id FROM games')).resolves.toMatchObject({
        rowCount: 0,
      });
    } finally {
      if (transactionOpen) await blocker.query('ROLLBACK');
      await publication?.catch(() => undefined);
      blocker.release();
    }
  });

  it('does not let a restart waiting behind publication overwrite the published draft', async () => {
    const groupId = await insertGroup(pool, '-1008', 'Restart race');
    const actorUserId = await insertUser(pool, '1008');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draftId = '018f6ba062d27bd18f1312e0c8424611';
    const originalDraft = {
      version: 1 as const,
      draftId,
      groupId,
      actorUserId,
      step: 'PREVIEW' as const,
      viewRevision: 1,
      cancelPending: false,
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    };
    await seedDraft(drafts, originalDraft);
    const input = {
      groupId,
      actorUserId,
      draftId,
      expectedStep: 'PREVIEW' as const,
      expectedViewRevision: 1,
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
    const replacement = {
      version: 1 as const,
      draftId: 'ffffffffffffffffffffffffffffffff',
      groupId,
      actorUserId,
      step: 'TEMPLATE' as const,
      viewRevision: 0,
      cancelPending: false,
      previewed: false,
    };
    const blocker = await pool.connect();
    let lockHeld = false;
    let publication: ReturnType<typeof games.publishDraft> | undefined;

    await installGameInsertBlocker(pool);
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [610_006]);
      lockHeld = true;
      publication = games.publishDraft(input, build);
      await waitForBlockedQuery(pool, 'insert into "games"');

      const restart = drafts.replaceForNewFlow(replacement, {
        draftId,
        step: 'PREVIEW',
        viewRevision: 1,
      });
      await waitForBlockedQuery(pool, 'update "game_creation_drafts"');

      await blocker.query('SELECT pg_advisory_unlock($1)', [610_006]);
      lockHeld = false;
      const [published, restartResult] = await Promise.all([
        publication,
        restart,
      ]);

      expect(restartResult).toBe('STALE');
      await expect(drafts.load(groupId, actorUserId)).resolves.toMatchObject({
        draftId,
        step: 'PUBLISHED',
        publishedGameId: published.game.id,
      });
    } finally {
      if (lockHeld) {
        await blocker.query('SELECT pg_advisory_unlock($1)', [610_006]);
      }
      await publication?.catch(() => undefined);
      blocker.release();
      await removeGameInsertBlocker(pool);
    }
  });

  it('rejects a stale draft id without committing publication state', async () => {
    const groupId = await insertGroup(pool, '-1004', 'Stale');
    const actorUserId = await insertUser(pool, '1004');
    const database = createDatabase(pool);
    const drafts = new GameCreationDraftRepository(database);
    const games = new GameRepository(database);
    const draft = {
      version: 1,
      draftId: '018f6ba062d27bd18f1312e0c8424611',
      groupId,
      actorUserId,
      step: 'PREVIEW',
      snapshot,
      startsAtIso: '2026-09-12T16:00:00.000Z',
      previewed: true,
    } as const;
    await seedDraft(drafts, draft);

    await expect(
      games.publishDraft(
        {
          groupId,
          actorUserId,
          draftId: 'ffffffffffffffffffffffffffffffff',
          expectedStep: 'PREVIEW',
          expectedViewRevision: 0,
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

const seedDraft = async (
  repository: GameCreationDraftRepository,
  draft: Parameters<GameCreationDraftRepository['compareAndSet']>[0],
): Promise<void> => {
  await repository.replaceForNewFlow({
    version: 1,
    draftId: draft.draftId,
    groupId: draft.groupId,
    actorUserId: draft.actorUserId,
    step: 'TEMPLATE',
    previewed: false,
  });
  const result = await repository.compareAndSet(draft);
  if (result !== 'SAVED') throw new Error('Failed to seed game draft');
};

const installGameInsertBlocker = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE OR REPLACE FUNCTION test_block_game_insert()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(610006);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER test_block_game_insert
    BEFORE INSERT ON games
    FOR EACH ROW EXECUTE FUNCTION test_block_game_insert();
  `);
};

const removeGameInsertBlocker = async (pool: Pool): Promise<void> => {
  await pool.query(`
    DROP TRIGGER IF EXISTS test_block_game_insert ON games;
    DROP FUNCTION IF EXISTS test_block_game_insert();
  `);
};

const waitForBlockedQuery = async (
  client: Pool | PoolClient,
  queryFragment: string,
): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await client.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1
      ) AS blocked`,
      [`%${queryFragment}%`],
    );
    if (result.rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for blocked query: ${queryFragment}`);
};
