import {
  asGameId,
  asGroupId,
  asTelegramId,
  asUserId,
  type RegistrationState,
} from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { RegistrationRepository } from './registration.repository.js';

describe('RegistrationRepository concurrency', () => {
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
      max: 5,
    });
    await applyTestMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('serializes final-place clicks and keeps repeated callbacks idempotent', async () => {
    const groupId = await insertGroup(pool);
    const gameId = await insertOpenGame(pool, groupId, 1);
    const [firstUserId, secondUserId] = await Promise.all([
      insertUser(pool, '101'),
      insertUser(pool, '102'),
    ]);
    const registrations = new RegistrationRepository(createDatabase(pool));

    const [first, second] = await Promise.all([
      registrations.registerParticipant({
        groupId,
        gameId,
        userId: firstUserId,
        intent: 'CONFIRMED',
        membershipPriority: 1,
        idempotencyKey: 'callback:1',
      }),
      registrations.registerParticipant({
        groupId,
        gameId,
        userId: secondUserId,
        intent: 'CONFIRMED',
        membershipPriority: 1,
        idempotencyKey: 'callback:2',
      }),
    ]);

    expect([first.state, second.state].sort()).toEqual([
      'ROSTERED',
      'WAITLISTED',
    ] satisfies RegistrationState[]);
    expect(
      [first, second].find((item) => item.state === 'ROSTERED'),
    ).toMatchObject({ rosterPosition: 1 });
    expect(
      [first, second].find((item) => item.state === 'WAITLISTED'),
    ).toMatchObject({ waitlistPosition: 1 });

    const repeated = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:1-repeat',
    });
    expect(repeated.registrationId).toBe(first.registrationId);
    expect(await activeCount(pool, gameId, firstUserId)).toBe(1);
  });

  it('rejects withdrawal of another participant and promotes the waiter', async () => {
    const groupId = await insertGroupWithChat(pool, '-2002');
    const gameId = await insertOpenGame(pool, groupId, 1);
    const ownerUserId = await insertUser(pool, '201');
    const waiterUserId = await insertUser(pool, '202');
    const strangerUserId = await insertUser(pool, '203');
    const registrations = new RegistrationRepository(createDatabase(pool));
    const rostered = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: ownerUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:withdraw-owner',
    });
    const waiter = await registrations.registerParticipant({
      groupId,
      gameId,
      userId: waiterUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:withdraw-waiter',
    });

    await expect(
      registrations.withdraw({
        groupId,
        gameId,
        registrationId: rostered.registrationId,
        actorUserId: strangerUserId,
        reason: 'NOT_MINE',
      }),
    ).rejects.toThrow(/own registration/i);

    await registrations.withdraw({
      groupId,
      gameId,
      registrationId: rostered.registrationId,
      actorUserId: ownerUserId,
      reason: 'PARTICIPANT_WITHDREW',
    });
    expect(await registrationState(pool, waiter.registrationId)).toBe(
      'ROSTERED',
    );
    const promotion = await pool.query<{ payload: { registrationId: string } }>(
      "SELECT payload FROM outbox_events WHERE event_type = 'WAITLIST_PROMOTED'",
    );
    expect(promotion.rows).toEqual([
      {
        payload: expect.objectContaining({
          registrationId: waiter.registrationId,
        }),
      },
    ]);
  });

  it('confirms once and makes the matching expiry revision harmless', async () => {
    const groupId = await insertGroupWithChat(pool, '-2003');
    const gameId = await insertOpenGame(pool, groupId, 1);
    const userId = await insertUser(pool, '301');
    const registrations = new RegistrationRepository(createDatabase(pool));
    const tentative = await registrations.registerParticipant({
      groupId,
      gameId,
      userId,
      intent: 'TENTATIVE',
      membershipPriority: 1,
      idempotencyKey: 'callback:tentative-confirm',
    });
    const confirmedAt = new Date('2026-09-09T16:30:00.000Z');

    const confirmed = await registrations.confirmTentative({
      groupId,
      gameId,
      registrationId: tentative.registrationId,
      actorUserId: userId,
      expectedConfirmationRevision: 0,
      confirmedAt,
    });
    const expiry = await registrations.expireTentative({
      groupId,
      gameId,
      registrationId: tentative.registrationId,
      expectedConfirmationRevision: 0,
      expiredAt: new Date('2026-09-09T17:00:00.000Z'),
    });

    expect(confirmed).toMatchObject({
      state: 'ROSTERED',
      confirmedAt,
      confirmationRevision: 1,
    });
    expect(expiry).toEqual({ expired: false });
    expect(await registrationState(pool, tentative.registrationId)).toBe(
      'ROSTERED',
    );

    await registrations.withdraw({
      groupId,
      gameId,
      registrationId: tentative.registrationId,
      actorUserId: userId,
      reason: 'TENTATIVE_DECLINED',
      expectedConfirmationRevision: 0,
    });
    expect(await registrationState(pool, tentative.registrationId)).toBe(
      'ROSTERED',
    );
  });

  it('stores the latest Telegram display name while resolving a player', async () => {
    const groupId = await insertGroupWithChat(pool, '-2005');
    const gameId = await insertOpenGame(pool, groupId, 12);
    const repository = new RegistrationRepository(createDatabase(pool));

    await repository.resolve(gameId, asTelegramId('501'), 'Ада Лавлейс');

    const stored = await pool.query<{ display_name: string | null }>(
      'SELECT display_name FROM users WHERE telegram_user_id = $1',
      ['501'],
    );
    expect(stored.rows).toEqual([{ display_name: 'Ада Лавлейс' }]);
  });

  it('switches directly between confirmed and tentative registration', async () => {
    const groupId = await insertGroupWithChat(pool, '-2006');
    const gameId = await insertOpenGame(pool, groupId, 1);
    const firstUserId = await insertUser(pool, '601');
    const secondUserId = await insertUser(pool, '602');
    const repository = new RegistrationRepository(createDatabase(pool));
    const first = await repository.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:switch-first',
    });
    const second = await repository.registerParticipant({
      groupId,
      gameId,
      userId: secondUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:switch-second',
    });

    const tentative = await repository.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'TENTATIVE',
      membershipPriority: 1,
      idempotencyKey: 'callback:switch-maybe',
    });

    expect(tentative).toMatchObject({
      registrationId: first.registrationId,
      state: 'TENTATIVE',
    });
    expect(await registrationState(pool, second.registrationId)).toBe(
      'ROSTERED',
    );

    const confirmedAgain = await repository.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:switch-going',
    });

    expect(confirmedAgain).toMatchObject({
      registrationId: first.registrationId,
      state: 'WAITLISTED',
      waitlistPosition: 1,
    });
  });

  it('updates the game revision transactionally, rebalances capacity, and separates schedule revisions', async () => {
    const groupId = await insertGroupWithChat(pool, '-2004');
    const gameId = await insertOpenGame(pool, groupId, 1);
    const firstUserId = await insertUser(pool, '401');
    const secondUserId = await insertUser(pool, '402');
    const actorUserId = await insertUser(pool, '499');
    const repository = new RegistrationRepository(createDatabase(pool));
    await repository.registerParticipant({
      groupId,
      gameId,
      userId: firstUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:update-first',
    });
    await repository.registerParticipant({
      groupId,
      gameId,
      userId: secondUserId,
      intent: 'CONFIRMED',
      membershipPriority: 1,
      idempotencyKey: 'callback:update-second',
    });

    const capacity = await repository.updateGame({
      groupId,
      gameId,
      actorUserId,
      expectedRevision: 0,
      changes: { capacity: 2, name: '  Updated game  ' },
    });

    expect(capacity).toMatchObject({
      game: {
        revision: 1,
        scheduleRevision: 0,
        capacity: 2,
        name: 'Updated game',
      },
      rosterCount: 2,
      waitlistCount: 0,
      materialFields: [],
    });
    await expect(
      repository.updateGame({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 0,
        changes: { capacity: 3 },
      }),
    ).rejects.toThrow('Игра уже была изменена. Откройте актуальную версию.');

    const timing = await repository.updateGame({
      groupId,
      gameId,
      actorUserId,
      expectedRevision: 1,
      changes: {
        startsAt: new Date('2026-09-11T16:00:00.000Z'),
        venue: 'New gym',
        address: 'New address',
      },
    });
    expect(timing).toMatchObject({
      game: { revision: 2, scheduleRevision: 1 },
      materialFields: ['startsAt', 'venue', 'address'],
    });

    await expect(
      repository.updateGame({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 2,
        changes: { memberPriorityEnabled: false },
      }),
    ).rejects.toThrow('Это поле нельзя изменить в текущем состоянии игры.');
    await expect(
      repository.updateGame({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 2,
        changes: { startsAt: new Date('2026-09-05T16:00:00.000Z') },
      }),
    ).rejects.toThrow('Время начала игры должно быть в будущем.');

    const updateEvents = await pool.query<{
      payload: Record<string, unknown>;
    }>(
      "SELECT payload FROM outbox_events WHERE event_type = 'GAME_UPDATED' ORDER BY occurred_at, id",
    );
    expect(updateEvents.rows).toHaveLength(2);
    expect(updateEvents.rows[1]!.payload).toMatchObject({
      revision: 2,
      scheduleRevision: 1,
      materialFields: ['startsAt', 'venue', 'address'],
      startsAtBefore: '2026-09-10T16:00:00.000Z',
      startsAtAfter: '2026-09-11T16:00:00.000Z',
      venueBefore: 'Gym',
      venueAfter: 'New gym',
      addressBefore: null,
      addressAfter: 'New address',
      displayBefore: {
        name: 'Updated game',
        startsAt: '2026-09-10T16:00:00.000Z',
        venue: 'Gym',
        address: null,
        timeZone: 'UTC',
      },
      displayAfter: {
        name: 'Updated game',
        startsAt: '2026-09-11T16:00:00.000Z',
        venue: 'New gym',
        address: 'New address',
        timeZone: 'UTC',
      },
    });

    const concurrent = await Promise.allSettled([
      repository.updateGame({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 2,
        changes: { capacity: 3 },
      }),
      repository.updateGame({
        groupId,
        gameId,
        actorUserId,
        expectedRevision: 2,
        changes: { venue: 'Concurrent gym' },
      }),
    ]);
    expect(
      concurrent.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      concurrent.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
  });
});

const insertGroup = async (pool: Pool) => {
  return insertGroupWithChat(pool, '-2001');
};

const insertGroupWithChat = async (pool: Pool, chatId: string) => {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO groups (telegram_chat_id, title, onboarding_state) VALUES ($1, 'Group', 'CONFIGURED') RETURNING id",
    [chatId],
  );
  return asGroupId(result.rows[0]!.id);
};

const registrationState = async (pool: Pool, registrationId: string) => {
  const result = await pool.query<{ state: RegistrationState }>(
    'SELECT state FROM registrations WHERE id = $1',
    [registrationId],
  );
  return result.rows[0]!.state;
};

const insertUser = async (pool: Pool, telegramId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id',
    [telegramId],
  );
  return asUserId(result.rows[0]!.id);
};

const insertOpenGame = async (
  pool: Pool,
  groupId: string,
  capacity: number,
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, registration_closes_at, tentative_prompt_at,
      tentative_response_deadline, reminder_at, member_priority_enabled, state
    ) VALUES (
      $1, 'Game', 'Gym', '2026-09-10T16:00:00Z', 120, $2, 'UTC',
      '2026-09-01T16:00:00Z', '2026-09-10T15:00:00Z',
      '2026-09-09T16:00:00Z', '2026-09-09T17:00:00Z',
      '2026-09-10T14:00:00Z', true, 'OPEN'
    ) RETURNING id`,
    [groupId, capacity],
  );
  return asGameId(result.rows[0]!.id);
};

const activeCount = async (pool: Pool, gameId: string, userId: string) => {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*) FROM registrations WHERE game_id = $1 AND user_id = $2 AND state <> 'CANCELLED'",
    [gameId, userId],
  );
  return Number(result.rows[0]!.count);
};
