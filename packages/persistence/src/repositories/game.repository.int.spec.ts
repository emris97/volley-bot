import { asGroupId, type GameTemplateSnapshot } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
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
