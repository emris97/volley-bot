import { asTelegramId, type TelegramId } from '@volley/domain';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabase } from '../client.js';
import { applyTestMigrations } from '../migrations/migration-test-helper.js';
import { GroupRepository } from './group.repository.js';
import { OrganizerDirectoryRepository } from './organizer-directory.repository.js';

describe('OrganizerDirectoryRepository', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let groups: GroupRepository;
  let directory: OrganizerDirectoryRepository;

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
    const database = createDatabase(pool);
    groups = new GroupRepository(database);
    directory = new OrganizerDirectoryRepository(database);
  }, 60_000);

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE organizer_preferences, outbox_events, audit_events, group_members, groups, users CASCADE',
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('keeps the selected disabled group in known group data for resolver validation', async () => {
    const telegramUserId = asTelegramId('42');
    const first = await groups.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000001'),
      title: 'First volleyball group',
    });
    const second = await groups.upsertFromTelegram({
      telegramChatId: asTelegramId('-1001000000002'),
      title: 'Second volleyball group',
    });
    await groups.upsertMembership(first.id, telegramUserId, 'ADMIN');
    await groups.upsertMembership(second.id, telegramUserId, 'OWNER');
    await pool.query(
      "UPDATE groups SET onboarding_state = 'CONFIGURED' WHERE id IN ($1, $2)",
      [first.id, second.id],
    );
    await directory.saveSelectedGroup(telegramUserId, second.id);
    await groups.setEnabled(second.id, false);

    const knownGroups = await directory.listKnownGroups(telegramUserId);
    expect(knownGroups).toHaveLength(2);
    expect(knownGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: first.id,
          title: 'First volleyball group',
          enabled: true,
          onboardingState: 'CONFIGURED',
          role: 'ADMIN',
          status: 'ACTIVE',
        }),
        expect.objectContaining({
          groupId: second.id,
          title: 'Second volleyball group',
          enabled: false,
          onboardingState: 'CONFIGURED',
          role: 'OWNER',
          status: 'ACTIVE',
        }),
      ]),
    );
    await expect(directory.selectedGroup(telegramUserId)).resolves.toBe(
      second.id,
    );

    const { ResolveOrganizerContext } = (await vi.importActual(
      '@volley/application',
    )) as {
      ResolveOrganizerContext: new (...args: unknown[]) => {
        list(telegramUserId: TelegramId): Promise<unknown>;
        require(telegramUserId: TelegramId): Promise<unknown>;
      };
    };
    const resolver = new ResolveOrganizerContext(
      {
        getChatMember: async (chatId: TelegramId) => ({
          status: chatId === first.telegramChatId ? 'administrator' : 'creator',
        }),
      },
      directory,
    );

    await expect(resolver.list(telegramUserId)).resolves.toEqual([
      expect.objectContaining({ groupId: first.id, selected: false }),
    ]);
    await expect(resolver.require(telegramUserId)).resolves.toMatchObject({
      groupId: first.id,
    });
  });
});
