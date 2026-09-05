import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asTelegramId } from '@volley/domain';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GroupRepository } from './group.repository.js';

describe('GroupRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repo: GroupRepository;

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
    repo = new GroupRepository(createDatabase(pool));
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('isolates memberships by group', async () => {
    const userTelegramId = asTelegramId('42');
    const first = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000001'),
      title: 'First',
    });
    const second = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000002'),
      title: 'Second',
    });
    await repo.upsertMembership(first.id, userTelegramId, 'ADMIN');

    expect(await repo.findMembership(first.id, userTelegramId)).toMatchObject({
      role: 'ADMIN',
    });
    expect(await repo.findMembership(second.id, userTelegramId)).toBeNull();
  });

  it('returns onboarding progress, Telegram chat, and settings in one snapshot', async () => {
    const telegramChatId = asTelegramId('-1001000000003');
    const group = await repo.upsertFromTelegram({
      telegramChatId,
      title: 'Astrakhan',
    });
    await repo.saveWizardProgress(group.id, {
      tz: 'Europe/Astrakhan',
      mp: true,
    });

    await expect(repo.getOnboardingSnapshot(group.id)).resolves.toMatchObject({
      telegramChatId,
      onboardingState: 'PENDING',
      progress: { tz: 'Europe/Astrakhan', mp: true },
      settings: {
        timeZone: 'UTC',
        memberPriorityEnabled: false,
        tentativePromptMinutesBefore: 1440,
        tentativeResponseMinutes: 60,
        reminderMinutesBefore: 120,
        currency: 'RUB',
        roundingMode: 'EXACT',
        pinGameMessages: true,
      },
    });
  });

  it('preserves existing progress when onboarding restarts', async () => {
    const actor = asTelegramId('43');
    const group = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000004'),
      title: 'Resume',
    });
    await repo.upsertMembership(group.id, actor, 'ADMIN');
    await repo.saveWizardProgress(group.id, { tz: 'Europe/Astrakhan' });

    await repo.beginOnboarding(group.id, actor);

    await expect(repo.getOnboardingSnapshot(group.id)).resolves.toMatchObject({
      onboardingState: 'CONFIGURING',
      progress: { tz: 'Europe/Astrakhan' },
    });
  });

  it('applies wizard progress only when the expected snapshot is current', async () => {
    const actorTelegramId = asTelegramId('45');
    const group = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000005'),
      title: 'Concurrent wizard',
    });
    await repo.upsertMembership(group.id, actorTelegramId, 'ADMIN');
    await repo.beginOnboarding(group.id, actorTelegramId);

    const first = await repo.compareAndSetWizardProgress(
      group.id,
      {},
      { tz: 'Europe/Astrakhan' },
    );
    const stale = await repo.compareAndSetWizardProgress(
      group.id,
      {},
      { mp: true },
    );

    expect([first, stale]).toEqual([true, false]);
    await expect(repo.getOnboardingSnapshot(group.id)).resolves.toMatchObject({
      progress: { tz: 'Europe/Astrakhan' },
    });
  });

  it('allows only one concurrent save for the same complete draft', async () => {
    const actorTelegramId = asTelegramId('44');
    const group = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000006'),
      title: 'Concurrent save',
    });
    await repo.upsertMembership(group.id, actorTelegramId, 'ADMIN');
    await repo.beginOnboarding(group.id, actorTelegramId);
    const progress = {
      tz: 'Europe/Astrakhan',
      mp: true,
      tp: 1440,
      tr: 60,
      rm: 120,
      ro: 'EXACT',
      pin: true,
    };
    await repo.saveWizardProgress(group.id, progress);
    const command = {
      groupId: group.id,
      actorTelegramId,
      timeZone: 'Europe/Astrakhan',
      memberPriorityEnabled: true,
      tentativePromptMinutesBefore: 1440,
      tentativeResponseMinutes: 60,
      reminderMinutesBefore: 120,
      currency: 'RUB' as const,
      roundingMode: 'EXACT' as const,
      pinGameMessages: true,
      expectedOnboardingProgress: progress,
    };

    const results = await Promise.all([
      repo.configure(command),
      repo.configure(command),
    ]);

    expect(results.toSorted()).toEqual([false, true]);
    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM audit_events
       WHERE group_id = $1 AND event_type = 'GROUP_CONFIGURED'`,
      [group.id],
    );
    expect(audit.rows[0]?.count).toBe('1');
  });

  it('serializes reset against save for the same complete draft', async () => {
    const actorTelegramId = asTelegramId('46');
    const group = await repo.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000007'),
      title: 'Save versus reset',
    });
    await repo.upsertMembership(group.id, actorTelegramId, 'ADMIN');
    await repo.beginOnboarding(group.id, actorTelegramId);
    const progress = {
      tz: 'Europe/Astrakhan',
      mp: true,
      tp: 1440,
      tr: 60,
      rm: 120,
      ro: 'EXACT',
      pin: true,
    };
    await repo.saveWizardProgress(group.id, progress);

    const [reset, saved] = await Promise.all([
      repo.compareAndSetWizardProgress(group.id, progress, {}),
      repo.configure({
        groupId: group.id,
        actorTelegramId,
        timeZone: 'Europe/Astrakhan',
        memberPriorityEnabled: true,
        tentativePromptMinutesBefore: 1440,
        tentativeResponseMinutes: 60,
        reminderMinutesBefore: 120,
        currency: 'RUB',
        roundingMode: 'EXACT',
        pinGameMessages: true,
        expectedOnboardingProgress: progress,
      }),
    ]);

    expect([reset, saved].filter(Boolean)).toHaveLength(1);
    await expect(repo.getOnboardingSnapshot(group.id)).resolves.toSatisfy(
      (current) =>
        current?.onboardingState === 'CONFIGURED' ||
        (current?.onboardingState === 'CONFIGURING' &&
          Object.keys(current.progress).length === 0),
    );
  });
});
