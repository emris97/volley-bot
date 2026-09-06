import {
  asGameId,
  asGroupId,
  asTelegramId,
  asUserId,
  type GameState,
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
import { GameRepository } from './game.repository.js';
import { ManagementRepository } from './management.repository.js';

describe('management repositories', () => {
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
      'TRUNCATE game_edit_sessions, attendance_snapshots, registrations, audit_events, outbox_events, games, group_members, groups, users CASCADE',
    );
  });

  it('pages exactly eight active games ascending and terminal buckets descending', async () => {
    const groupId = await insertGroup(pool, '-3101');
    const otherGroupId = await insertGroup(pool, '-3102');
    const repository = new GameRepository(createDatabase(pool));
    const upcoming = [];
    for (let day = 1; day <= 10; day += 1) {
      upcoming.push(
        await insertGame(
          pool,
          groupId,
          `Upcoming ${day}`,
          new Date(Date.UTC(2026, 9, day, 16)),
          day % 2 === 0 ? 'OPEN' : 'SCHEDULED',
        ),
      );
    }
    await insertGame(
      pool,
      otherGroupId,
      'Other tenant',
      new Date(Date.UTC(2026, 8, 1, 16)),
      'OPEN',
    );
    await insertGame(
      pool,
      groupId,
      'History older',
      new Date(Date.UTC(2026, 7, 1, 16)),
      'COMPLETED',
    );
    await insertGame(
      pool,
      groupId,
      'History newer',
      new Date(Date.UTC(2026, 7, 3, 16)),
      'COMPLETED',
    );
    await insertGame(
      pool,
      groupId,
      'Cancelled older',
      new Date(Date.UTC(2026, 7, 2, 16)),
      'CANCELLED',
    );
    await insertGame(
      pool,
      groupId,
      'Cancelled newer',
      new Date(Date.UTC(2026, 7, 4, 16)),
      'CANCELLED',
    );

    const first = await repository.list(groupId, {
      bucket: 'UPCOMING',
      limit: 8,
      cursor: null,
    });
    expect(first.items).toHaveLength(8);
    expect(first.items.map(({ name }) => name)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Upcoming ${index + 1}`),
    );
    expect(first.nextCursor).toBe(upcoming[7]);
    await expect(
      repository.list(groupId, {
        bucket: 'UPCOMING',
        limit: 8,
        cursor: first.nextCursor,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ name: 'Upcoming 9' }),
        expect.objectContaining({ name: 'Upcoming 10' }),
      ],
      nextCursor: null,
    });
    await expect(
      repository.list(groupId, {
        bucket: 'HISTORY',
        limit: 8,
        cursor: null,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ name: 'Cancelled newer' }),
        expect.objectContaining({ name: 'History newer' }),
        expect.objectContaining({ name: 'Cancelled older' }),
        expect.objectContaining({ name: 'History older' }),
      ],
    });
    await expect(
      repository.list(groupId, {
        bucket: 'CANCELLED',
        limit: 8,
        cursor: null,
      }),
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({ name: 'Cancelled newer' }),
        expect.objectContaining({ name: 'Cancelled older' }),
      ],
    });
  });

  it('physically deletes only a current unpublished unreferenced draft', async () => {
    const groupId = await insertGroup(pool, '-3201');
    const actorUserId = await insertUser(pool, '3201');
    const repository = new GameRepository(createDatabase(pool));
    const draftId = await insertGame(
      pool,
      groupId,
      'Draft',
      new Date('2026-10-01T16:00:00.000Z'),
      'DRAFT',
      { revision: 2 },
    );
    await expect(
      repository.deleteDraft({
        groupId,
        gameId: asGameId(draftId),
        actorUserId,
        expectedRevision: 1,
      }),
    ).resolves.toBe('STALE');
    await expect(
      repository.deleteDraft({
        groupId,
        gameId: asGameId(draftId),
        actorUserId,
        expectedRevision: 2,
      }),
    ).resolves.toBe('DELETED');

    const publishedDraftId = await insertGame(
      pool,
      groupId,
      'Published draft',
      new Date('2026-10-02T16:00:00.000Z'),
      'DRAFT',
      { canonicalMessageId: 11n },
    );
    await expect(
      repository.deleteDraft({
        groupId,
        gameId: asGameId(publishedDraftId),
        actorUserId,
        expectedRevision: 0,
      }),
    ).resolves.toBe('NOT_DELETABLE');

    const referencedDraftId = await insertGame(
      pool,
      groupId,
      'Referenced draft',
      new Date('2026-10-03T16:00:00.000Z'),
      'DRAFT',
    );
    await insertRegistration(
      pool,
      groupId,
      referencedDraftId,
      actorUserId,
      'ROSTERED',
    );
    await expect(
      repository.deleteDraft({
        groupId,
        gameId: asGameId(referencedDraftId),
        actorUserId,
        expectedRevision: 0,
      }),
    ).resolves.toBe('NOT_DELETABLE');

    const scheduledId = await insertGame(
      pool,
      groupId,
      'Scheduled',
      new Date('2026-10-04T16:00:00.000Z'),
      'SCHEDULED',
    );
    await expect(
      repository.deleteDraft({
        groupId,
        gameId: asGameId(scheduledId),
        actorUserId,
        expectedRevision: 0,
      }),
    ).resolves.toBe('NOT_DELETABLE');
  });

  it('resolves a game location, links an unknown live administrator, and returns a complete private view', async () => {
    const groupId = await insertGroup(pool, '-3301');
    const gameId = await insertGame(
      pool,
      groupId,
      'Managed game',
      new Date('2026-10-05T16:00:00.000Z'),
      'COMPLETED',
      { revision: 4 },
    );
    const repository = new ManagementRepository(createDatabase(pool));
    const telegramUserId = asTelegramId('3301');

    await expect(
      repository.resolveGameGroup(asGameId(gameId)),
    ).resolves.toEqual({
      groupId,
      telegramChatId: asTelegramId('-3301'),
    });
    const userId = await repository.refreshMembership({
      groupId,
      telegramUserId,
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    await insertRegistration(pool, groupId, gameId, userId, 'ROSTERED');
    await insertRegistration(pool, groupId, gameId, null, 'WAITLISTED', userId);
    await insertRegistration(pool, groupId, gameId, userId, 'CANCELLED');
    await pool.query(
      'INSERT INTO attendance_snapshots (group_id, game_id, revision, finalized) VALUES ($1, $2, 1, true)',
      [groupId, gameId],
    );

    await expect(
      repository.resolve(asGameId(gameId), telegramUserId),
    ).resolves.toMatchObject({
      groupId,
      gameId,
      userId,
      telegramChatId: asTelegramId('-3301'),
      gameState: 'COMPLETED',
      game: { name: 'Managed game', revision: 4 },
      dmAvailable: false,
      registrationCount: 3,
      rosterCount: 1,
      waitlistCount: 1,
      hasFinalizedAttendance: true,
    });
    await repository.markPrivateAvailable(telegramUserId);
    await expect(
      repository.resolve(asGameId(gameId), telegramUserId),
    ).resolves.toMatchObject({ dmAvailable: true });
  });

  it('persists revisioned edit interaction state and scopes every mutation to tenant and actor', async () => {
    const groupId = await insertGroup(pool, '-3401');
    const otherGroupId = await insertGroup(pool, '-3402');
    const actorUserId = await insertUser(pool, '3401');
    const gameId = asGameId(
      await insertGame(
        pool,
        groupId,
        'Editable game',
        new Date('2026-10-06T16:00:00.000Z'),
        'SCHEDULED',
        { revision: 6 },
      ),
    );
    const repository = new ManagementRepository(createDatabase(pool));

    const started = await repository.startEditSession({
      groupId,
      actorUserId,
      gameId,
      expectedGameRevision: 6,
      selectedField: 'startsAt',
    });
    expect(started).toMatchObject({
      groupId,
      actorUserId,
      gameId,
      expectedGameRevision: 6,
      selectedField: 'startsAt',
      interactionRevision: 0,
      pendingChanges: null,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });

    await expect(
      repository.saveEditSessionChanges({
        groupId: otherGroupId,
        actorUserId,
        gameId,
        expectedGameRevision: 6,
        expectedInteractionRevision: 0,
        pendingChanges: {
          startsAt: new Date('2026-10-07T16:30:00.000Z'),
        },
      }),
    ).resolves.toBeNull();
    const pending = await repository.saveEditSessionChanges({
      groupId,
      actorUserId,
      gameId,
      expectedGameRevision: 6,
      expectedInteractionRevision: 0,
      pendingChanges: {
        startsAt: new Date('2026-10-07T16:30:00.000Z'),
      },
    });
    expect(pending).toMatchObject({
      selectedField: 'startsAt',
      interactionRevision: 1,
      pendingChanges: {
        startsAt: new Date('2026-10-07T16:30:00.000Z'),
      },
    });
    await expect(
      repository.saveEditSessionChanges({
        groupId,
        actorUserId,
        gameId,
        expectedGameRevision: 6,
        expectedInteractionRevision: 0,
        pendingChanges: { startsAt: new Date('2026-10-08T16:30:00.000Z') },
      }),
    ).resolves.toBeNull();
    await expect(
      repository.loadEditSession(otherGroupId, actorUserId),
    ).resolves.toBeNull();
    await expect(
      repository.resolveLatestEditScope(asTelegramId('3401')),
    ).resolves.toEqual({ groupId, actorUserId });
    await expect(
      repository.clearEditSession({
        groupId: otherGroupId,
        actorUserId,
        gameId,
        expectedInteractionRevision: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.clearEditSession({
        groupId,
        actorUserId,
        gameId,
        expectedInteractionRevision: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.loadEditSession(groupId, actorUserId),
    ).resolves.toBeNull();
    await expect(
      repository.resolveLatestEditScope(asTelegramId('3401')),
    ).resolves.toBeNull();
    await expect(
      repository.startEditSession({
        groupId,
        actorUserId,
        gameId,
        expectedGameRevision: 6,
        selectedField: 'totalCostMinor',
      }),
    ).resolves.toMatchObject({ interactionRevision: 3 });
    await expect(
      repository.saveEditSessionChanges({
        groupId,
        actorUserId,
        gameId,
        expectedGameRevision: 6,
        expectedInteractionRevision: 3,
        pendingChanges: { totalCostMinor: 125_050n },
      }),
    ).resolves.toMatchObject({
      interactionRevision: 4,
      pendingChanges: { totalCostMinor: 125_050n },
    });
  });

  it('loads completed summary from the latest finalized attendance and active tenant settlement', async () => {
    const groupId = await insertGroup(pool, '-3501');
    const actorUserId = await insertUser(pool, '3501');
    const gameId = await insertGame(
      pool,
      groupId,
      'Completed game',
      new Date('2026-10-07T16:00:00.000Z'),
      'COMPLETED',
    );
    await insertRegistration(pool, groupId, gameId, actorUserId, 'ROSTERED');
    await insertRegistration(pool, groupId, gameId, actorUserId, 'CANCELLED');
    const older = await pool.query<{ id: string }>(
      `INSERT INTO attendance_snapshots
        (group_id, game_id, revision, finalized)
       VALUES ($1, $2, 1, true)
       RETURNING id`,
      [groupId, gameId],
    );
    const latest = await pool.query<{ id: string }>(
      `INSERT INTO attendance_snapshots
        (group_id, game_id, revision, finalized)
       VALUES ($1, $2, 2, true)
       RETURNING id`,
      [groupId, gameId],
    );
    const draft = await pool.query<{ id: string }>(
      `INSERT INTO attendance_snapshots
        (group_id, game_id, revision, finalized)
       VALUES ($1, $2, 3, false)
       RETURNING id`,
      [groupId, gameId],
    );
    await insertAttendanceEntry(pool, groupId, older.rows[0]!.id, 'old', true);
    await insertAttendanceEntry(pool, groupId, latest.rows[0]!.id, 'one', true);
    await insertAttendanceEntry(
      pool,
      groupId,
      latest.rows[0]!.id,
      'two',
      false,
    );
    await insertAttendanceEntry(
      pool,
      groupId,
      draft.rows[0]!.id,
      'draft',
      true,
    );
    const settlement = await pool.query<{ id: string }>(
      `INSERT INTO settlements (
        group_id, game_id, attendance_snapshot_id, attendance_revision,
        revision, total_minor, currency, rounding_mode, allocation_order,
        collected_minor, surplus_minor, created_by
      ) VALUES ($1, $2, $3, 2, 1, 3000, 'RUB', 'EXACT', '[]', 3000, 0, $4)
      RETURNING id`,
      [groupId, gameId, latest.rows[0]!.id, actorUserId],
    );
    await insertCharge(
      pool,
      groupId,
      settlement.rows[0]!.id,
      'paid',
      1000,
      'PAID',
    );
    await insertCharge(
      pool,
      groupId,
      settlement.rows[0]!.id,
      'unpaid',
      1500,
      'UNPAID',
    );
    await insertCharge(
      pool,
      groupId,
      settlement.rows[0]!.id,
      'waived',
      500,
      'WAIVED',
    );

    const repository = new ManagementRepository(createDatabase(pool));

    await expect(
      repository.loadSummary(groupId, asGameId(gameId)),
    ).resolves.toEqual({
      participationCount: 1,
      attendance: { presentCount: 2, billableCount: 1 },
      settlement: {
        totalMinor: 3000n,
        paidCount: 1,
        paidMinor: 1000n,
        unpaidCount: 1,
        unpaidMinor: 1500n,
        waivedCount: 1,
        waivedMinor: 500n,
      },
    });
    await expect(
      repository.loadSummary(
        await insertGroup(pool, '-3502'),
        asGameId(gameId),
      ),
    ).resolves.toBeNull();
  });
});

const insertGroup = async (pool: Pool, telegramChatId: string) => {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO groups (telegram_chat_id, title, onboarding_state) VALUES ($1, 'Group', 'CONFIGURED') RETURNING id",
    [telegramChatId],
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

const insertGame = async (
  pool: Pool,
  groupId: string,
  name: string,
  startsAt: Date,
  state: GameState,
  options: { revision?: number; canonicalMessageId?: bigint } = {},
) => {
  const minute = 60_000;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, registration_closes_at, tentative_prompt_at,
      tentative_response_deadline, reminder_at, member_priority_enabled, state,
      revision, canonical_telegram_message_id
    ) VALUES ($1, $2, 'Gym', $3, 120, 12, 'UTC', $4, $5, $6, $7, $8, true, $9, $10, $11)
    RETURNING id`,
    [
      groupId,
      name,
      startsAt,
      new Date(startsAt.getTime() - 10_080 * minute),
      new Date(startsAt.getTime() - 60 * minute),
      new Date(startsAt.getTime() - 1_440 * minute),
      new Date(startsAt.getTime() - 1_380 * minute),
      new Date(startsAt.getTime() - 120 * minute),
      state,
      options.revision ?? 0,
      options.canonicalMessageId ?? null,
    ],
  );
  return result.rows[0]!.id;
};

const insertRegistration = async (
  pool: Pool,
  groupId: string,
  gameId: string,
  userId: string | null,
  state: 'ROSTERED' | 'WAITLISTED' | 'CANCELLED',
  inviterUserId?: string,
) => {
  await pool.query(
    `INSERT INTO registrations (
      group_id, game_id, user_id, inviter_user_id, guest_display_name, kind,
      membership_priority, state, idempotency_key, confirmed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, now())`,
    [
      groupId,
      gameId,
      userId,
      userId === null ? inviterUserId : null,
      userId === null ? 'Guest' : null,
      userId === null ? 'GUEST' : 'MEMBER',
      state,
      `management:${gameId}:${state}:${userId ?? 'guest'}`,
    ],
  );
};

const insertAttendanceEntry = async (
  pool: Pool,
  groupId: string,
  snapshotId: string,
  participantRef: string,
  billable: boolean,
): Promise<void> => {
  await pool.query(
    `INSERT INTO attendance_entries (
      snapshot_id, group_id, participant_ref, display_name, billable,
      added_manually
    ) VALUES ($1, $2, $3, $3, $4, true)`,
    [snapshotId, groupId, participantRef, billable],
  );
};

const insertCharge = async (
  pool: Pool,
  groupId: string,
  settlementId: string,
  participantRef: string,
  amountMinor: number,
  status: 'UNPAID' | 'PAID' | 'WAIVED',
): Promise<void> => {
  await pool.query(
    `INSERT INTO settlement_charges (
      settlement_id, group_id, participant_ref, display_name, added_manually,
      amount_minor, status
    ) VALUES ($1, $2, $3, $3, true, $4, $5)`,
    [settlementId, groupId, participantRef, amountMinor, status],
  );
};
