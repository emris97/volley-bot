import { asGameId, asGroupId, asUserId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { PaymentRepository } from './payment.repository.js';

describe('PaymentRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repository: PaymentRepository;

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
    repository = new PaymentRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE charge_status_events, settlement_charges, settlements, outbox_events, audit_events, attendance_entries, attendance_snapshots, registrations, games, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('keeps settlement revisions immutable and tenant-scoped with durable charges and status events', async () => {
    const fixture = await insertFixture(pool);
    const first = await createRevision(repository, fixture, 10000n, 5000n);
    const corrected = await createRevision(repository, fixture, 12000n, 6000n);

    expect(first.revision).toBe(1);
    expect(first.charges).toHaveLength(2);
    expect(first.charges).toContainEqual(
      expect.objectContaining({
        participantRef: 'manual:late-player',
        addedManually: true,
        amountMinor: 5000n,
      }),
    );
    expect(corrected.revision).toBe(2);
    expect(corrected.charges).toHaveLength(2);

    const stored = await pool.query<{
      revision: number;
      total_minor: string;
      superseded_at: Date | null;
    }>(
      'SELECT revision, total_minor, superseded_at FROM settlements ORDER BY revision',
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({
        revision: 1,
        total_minor: '10000',
        superseded_at: expect.any(Date),
      }),
      { revision: 2, total_minor: '12000', superseded_at: null },
    ]);
    await expect(
      pool.query(
        'SELECT amount_minor, status FROM settlement_charges WHERE settlement_id = $1 ORDER BY participant_ref',
        [first.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        { amount_minor: '5000', status: 'UNPAID' },
        { amount_minor: '5000', status: 'UNPAID' },
      ],
    });

    const registeredCharge = corrected.charges.find(
      (charge) => !charge.addedManually,
    )!;
    await expect(
      repository.changeChargeStatus({
        groupId: fixture.otherGroupId,
        chargeId: registeredCharge.id,
        actorUserId: fixture.actorUserId,
        status: 'PAID',
      }),
    ).rejects.toThrow(/charge not found/i);
    await expect(
      repository.changeChargeStatus({
        groupId: fixture.groupId,
        chargeId: first.charges[0]!.id,
        actorUserId: fixture.actorUserId,
        status: 'PAID',
      }),
    ).rejects.toThrow(/charge not found/i);

    const paid = await repository.changeChargeStatus({
      groupId: fixture.groupId,
      chargeId: registeredCharge.id,
      actorUserId: fixture.actorUserId,
      status: 'PAID',
    });
    expect(paid.status).toBe('PAID');
    const event = await pool.query<{
      actor_user_id: string;
      previous_status: string;
      status: string;
    }>(
      `SELECT actor_user_id, previous_status, status
       FROM charge_status_events WHERE charge_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [registeredCharge.id],
    );
    expect(event.rows[0]).toEqual({
      actor_user_id: fixture.actorUserId,
      previous_status: 'UNPAID',
      status: 'PAID',
    });
  });

  it('locks the selected finalized attendance revision while creating charges', async () => {
    const fixture = await insertFixture(pool);
    const lockingClient = await pool.connect();
    await lockingClient.query('BEGIN');
    await lockingClient.query(
      'SELECT id FROM attendance_snapshots WHERE id = $1 FOR UPDATE',
      [fixture.attendanceSnapshotId],
    );

    let completed = false;
    const pending = createRevision(repository, fixture, 10000n, 5000n).then(
      (settlement) => {
        completed = true;
        return settlement;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(false);

    await lockingClient.query('COMMIT');
    lockingClient.release();
    await expect(pending).resolves.toMatchObject({ revision: 1 });

    await pool.query(
      'UPDATE attendance_snapshots SET finalized = FALSE WHERE id = $1',
      [fixture.attendanceSnapshotId],
    );
    await expect(
      createRevision(repository, fixture, 10000n, 5000n),
    ).rejects.toThrow(/finalized attendance revision required/i);
  });

  it('writes explicit selected private reminders to the durable outbox', async () => {
    const fixture = await insertFixture(pool);
    const settlement = await createRevision(repository, fixture, 10000n, 5000n);
    const registeredCharge = settlement.charges.find(
      (charge) => !charge.addedManually,
    )!;
    const manualCharge = settlement.charges.find(
      (charge) => charge.addedManually,
    )!;

    await expect(
      repository.enqueueReminders({
        groupId: fixture.groupId,
        actorUserId: fixture.actorUserId,
        chargeIds: [registeredCharge.id],
      }),
    ).resolves.toEqual({ enqueued: 1 });
    const intent = await pool.query<{
      event_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, aggregate_id, payload
       FROM outbox_events WHERE event_type = 'PAYMENT_REMINDER_REQUESTED'`,
    );
    expect(intent.rows).toEqual([
      {
        event_type: 'PAYMENT_REMINDER_REQUESTED',
        aggregate_id: registeredCharge.id,
        payload: expect.objectContaining({
          channel: 'PRIVATE',
          chargeId: registeredCharge.id,
          recipientUserId: fixture.participantUserId,
        }),
      },
    ]);

    await expect(
      repository.enqueueReminders({
        groupId: fixture.groupId,
        actorUserId: fixture.actorUserId,
        chargeIds: [manualCharge.id],
      }),
    ).rejects.toThrow(/private reminder recipient/i);
  });
});

const createRevision = async (
  repository: PaymentRepository,
  fixture: Awaited<ReturnType<typeof insertFixture>>,
  totalMinor: bigint,
  amountMinor: bigint,
) =>
  repository.withLockedFinalizedAttendance(
    fixture.groupId,
    fixture.gameId,
    1,
    async (snapshot, changes) =>
      changes.createRevision({
        actorUserId: fixture.actorUserId,
        totalMinor,
        currency: 'RUB',
        roundingMode: 'EXACT',
        allocationOrder: snapshot.entries
          .filter((entry) => entry.billable)
          .map((entry) => entry.participantRef)
          .toSorted(),
        collectedMinor: amountMinor * 2n,
        surplusMinor: amountMinor * 2n - totalMinor,
        charges: snapshot.entries
          .filter((entry) => entry.billable)
          .toSorted((left, right) =>
            left.participantRef.localeCompare(right.participantRef),
          )
          .map((entry) => ({
            participantRef: entry.participantRef,
            displayName: entry.displayName,
            addedManually: entry.addedManually,
            amountMinor,
          })),
      }),
  );

const insertFixture = async (pool: Pool) => {
  const groupId = await insertGroup(pool, '-1001');
  const otherGroupId = await insertGroup(pool, '-1002');
  const actorUserId = await insertUser(pool, '42', 'Organizer');
  const participantUserId = await insertUser(pool, '43', 'Player');
  const gameId = await insertGame(pool, groupId);
  const registration = await pool.query<{ id: string }>(
    `INSERT INTO registrations (
      group_id, game_id, user_id, kind, membership_priority, state,
      idempotency_key, confirmed_at
    ) VALUES ($1, $2, $3, 'MEMBER', 1, 'ROSTERED', $4, NOW()) RETURNING id`,
    [groupId, gameId, participantUserId, `payment:${gameId}`],
  );
  const attendance = await pool.query<{ id: string }>(
    `INSERT INTO attendance_snapshots (group_id, game_id, revision, finalized)
     VALUES ($1, $2, 1, TRUE) RETURNING id`,
    [groupId, gameId],
  );
  const attendanceSnapshotId = attendance.rows[0]!.id;
  await pool.query(
    `INSERT INTO attendance_entries (
      snapshot_id, group_id, participant_ref, source_registration_id,
      display_name, billable, added_manually
    ) VALUES
      ($1, $2, $3, $4, 'Player', TRUE, FALSE),
      ($1, $2, 'manual:late-player', NULL, 'Late player', TRUE, TRUE)`,
    [
      attendanceSnapshotId,
      groupId,
      `registration:${registration.rows[0]!.id}`,
      registration.rows[0]!.id,
    ],
  );
  return {
    groupId,
    otherGroupId,
    actorUserId,
    participantUserId,
    gameId,
    attendanceSnapshotId,
  };
};

const insertGroup = async (pool: Pool, telegramChatId: string) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO groups (telegram_chat_id, title) VALUES ($1, $2) RETURNING id',
    [telegramChatId, telegramChatId],
  );
  return asGroupId(result.rows[0]!.id);
};

const insertUser = async (
  pool: Pool,
  telegramUserId: string,
  displayName: string,
) => {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO users (telegram_user_id, display_name) VALUES ($1, $2) RETURNING id',
    [telegramUserId, displayName],
  );
  return asUserId(result.rows[0]!.id);
};

const insertGame = async (
  pool: Pool,
  groupId: ReturnType<typeof asGroupId>,
) => {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO games (
      group_id, name, venue, starts_at, duration_minutes, capacity, time_zone,
      registration_opens_at, tentative_prompt_at, tentative_response_deadline,
      reminder_at, member_priority_enabled, state
    ) VALUES ($1, 'Friday volleyball', 'Arena', NOW(), 120, 12, 'UTC',
      NOW(), NOW(), NOW(), NOW(), TRUE, 'COMPLETED') RETURNING id`,
    [groupId],
  );
  return asGameId(result.rows[0]!.id);
};
