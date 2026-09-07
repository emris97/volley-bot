import { readdir, readFile } from 'node:fs/promises';
import type {
  GameCreationDraft,
  PublishGameCommand,
  OrganizerContext,
  OrganizerGroupCandidate,
  OrganizerTextFlowCoordinator,
} from '@volley/application';
import { PublishGame, TemplateInputError } from '@volley/application';
import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asTelegramId,
  asUserId,
  createGameFromTemplate,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type TelegramId,
} from '@volley/domain';
import {
  createDatabase,
  GameCreationDraftRepository as PostgresGameCreationDraftRepository,
  GameRepository,
  TemplateRepository,
} from '@volley/persistence';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GameCreationHandlers,
  registerGameCreationHandlers,
  type GameCreationDefaults,
  type GameCreationDraftRepository,
  type GameCreationHandlerOptions,
  type GameCreationOrganizerContext,
  type GameCreationTemplates,
} from './game-creation.handlers.js';

const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: 'Volley',
  username: 'volley_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
const firstGroupId = asGroupId('10000000-0000-4000-8000-000000000001');
const secondGroupId = asGroupId('10000000-0000-4000-8000-000000000002');
const actorUserId = asUserId('20000000-0000-4000-8000-000000000001');
const migrationsUrl = new URL(
  '../../../persistence/migrations/',
  import.meta.url,
);

describe('private game creation bot flow', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let drafts: MemoryDrafts;
  let templates: MemoryTemplates;
  let publisher: MemoryPublisher;
  let organizer: MemoryOrganizer;
  let harness: ReturnType<typeof createHarness>;

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
    for (const file of (await readdir(migrationsUrl)).sort()) {
      if (file.endsWith('.sql')) {
        await pool.query(await readFile(new URL(file, migrationsUrl), 'utf8'));
      }
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE game_creation_drafts, audit_events, outbox_events, games, game_templates, groups, users CASCADE',
    );
    drafts = new MemoryDrafts();
    templates = new MemoryTemplates();
    publisher = new MemoryPublisher(drafts);
    organizer = new MemoryOrganizer([firstGroupId, secondGroupId]);
    templates.seed(firstGroupId, 'Среда вечером');
    harness = createHarness(organizer, drafts, templates, publisher);
  });

  it('creates and publishes one game through group, template, date, edit and preview', async () => {
    await pool.query(
      `INSERT INTO groups (id, telegram_chat_id, title, time_zone, onboarding_state)
       VALUES ($1, -1001, 'Команда 1', 'Europe/Astrakhan', 'CONFIGURED')`,
      [firstGroupId],
    );
    await pool.query(
      'INSERT INTO users (id, telegram_user_id) VALUES ($1, 42)',
      [actorUserId],
    );
    await pool.query(
      `INSERT INTO group_members (group_id, user_id, role, membership_status)
       VALUES ($1, $2, 'ADMIN', 'ACTIVE')`,
      [firstGroupId, actorUserId],
    );
    const database = createDatabase(pool);
    const postgresDrafts = new PostgresGameCreationDraftRepository(database);
    const postgresTemplates = new TemplateRepository(database);
    const postgresGames = new GameRepository(database);
    await postgresTemplates.insert({
      groupId: firstGroupId,
      ...defaultSnapshot('Среда вечером'),
    });
    organizer = new MemoryOrganizer([firstGroupId, secondGroupId]);
    harness = createHarness(
      organizer,
      postgresDrafts,
      {
        list: ({ groupId, ...options }) =>
          postgresTemplates.list(groupId, options),
        findById: (groupId, templateId) =>
          postgresTemplates.findById(groupId, templateId),
      },
      new PublishGame(
        { requireOrganizer: async () => undefined },
        { findTimeZone: async () => 'Europe/Astrakhan' },
        postgresGames,
      ),
    );
    await harness.command('/newgame');
    expect(organizer.listCalls).toBe(1);
    await harness.click('Команда 1');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Время начала');
    await harness.click('20');
    await harness.click('20:15');
    await harness.click('Количество мест');
    await harness.text('24');
    await harness.click('Предпросмотр');
    const publishData = harness.dataFor('Опубликовать');
    await harness.callback(publishData);

    await expect(
      pool.query<{ count: string }>(
        "SELECT count(*) FROM audit_events WHERE event_type = 'GAME_CREATED'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(
      pool.query<{ count: string }>(
        "SELECT count(*) FROM outbox_events WHERE event_type = 'GAME_CREATED'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    expect(harness.lastMessage()).toBe(
      '✅ Игра опубликована\nКарточка появится в группе. Если закрепление недоступно, предупреждение будет показано в управлении игрой.',
    );
    expect(harness.visibleText()).not.toMatch(
      /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i,
    );
    expect(
      harness
        .callbackData()
        .filter((data) => data.startsWith('gc:'))
        .every(
          (data) =>
            data.startsWith('gc:v1:') && Buffer.byteLength(data, 'utf8') < 64,
        ),
    ).toBe(true);

    await harness.callback(publishData);
    await expect(pool.query('SELECT id FROM games')).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(
      pool.query(
        "SELECT id FROM outbox_events WHERE event_type = 'GAME_CREATED'",
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('creates a minimal game without a template using date and time pickers', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(
      organizer,
      drafts,
      templates,
      publisher,
      undefined,
      {
        load: async () => ({
          memberPriorityEnabled: true,
          tentativePromptMinutesBefore: 720,
          tentativeResponseMinutes: 45,
          reminderMinutesBefore: 90,
          currency: 'RUB',
          roundingMode: 'UP_10',
        }),
      },
    );

    await harness.command('/newgame');
    await harness.click('Без шаблона');
    expect(harness.lastMessage()).toContain('Место игры');
    await harness.text('Арена');
    expect(harness.lastMessage()).toContain('Выберите дату');
    await harness.click('10');
    expect(harness.lastMessage()).toContain('Выберите час');
    await harness.click('19');
    await harness.click('19:30');
    expect(harness.lastMessage()).toContain('Сколько игроков');
    await harness.click('12');
    expect(harness.lastMessage()).toContain('Общая стоимость');
    await harness.text('2400');

    expect(harness.lastMessage()).toContain('Настройки игры');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'CUSTOMIZE',
      startsAtIso: '2026-09-10T15:30:00.000Z',
      snapshot: {
        name: 'Волейбол',
        venue: 'Арена',
        startsAtLocalTime: '19:30',
        durationMinutes: 120,
        capacity: 12,
        registrationOpensMinutesBefore: 7_410,
        defaultTotalCostMinor: 240_000n,
        memberPriorityEnabled: true,
        tentativePromptMinutesBefore: 720,
        tentativeResponseMinutes: 45,
        reminderMinutesBefore: 90,
        roundingMode: 'UP_10',
      },
    });
    await harness.click('Предпросмотр');
    expect(harness.lastMessage()).toContain('Регистрация откроется сразу');
    await harness.click('Опубликовать');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'PUBLISHED',
      templateId: undefined,
    });
  });

  it('resumes a persisted draft after handler recreation and supports back', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');

    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    expect(harness.buttons()).toContain('Продолжить');
    await harness.click('Продолжить');
    expect(harness.lastMessage()).toContain('ДД.ММ.ГГГГ');
    await harness.text('10.09.2026');
    await harness.click('Назад');
    expect(harness.lastMessage()).toContain('ДД.ММ.ГГГГ');
  });

  it('rejects control-free continue and restart callbacks without mutating the draft', async () => {
    await harness.command('/newgame');
    await harness.click('Команда 1');
    const before = await drafts.load(firstGroupId, actorUserId);

    for (const data of ['gc:v1:c', 'gc:v1:r', 'gc:v1:r:junk:extra']) {
      await harness.callback(data);
      expect(await drafts.load(firstGroupId, actorUserId)).toEqual(before);
      expect(harness.lastMessage()).toContain('кнопка устарела');
    }
  });

  it('requires confirmed cancellation and leaves no text-owning draft', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.click('Отмена');
    expect(harness.lastMessage()).toContain('Отменить создание игры?');
    await harness.click('Нет');
    expect(harness.lastMessage()).toContain('ДД.ММ.ГГГГ');
    await harness.click('Отмена');
    await harness.click('Да, отменить');

    expect(await drafts.load(firstGroupId, actorUserId)).toBeNull();
    const fallbacks = harness.fallbackCount();
    await harness.text('обычное сообщение');
    expect(harness.fallbackCount()).toBe(fallbacks + 1);
  });

  it('shows an empty state when the selected group has no active templates', async () => {
    organizer = new MemoryOrganizer([secondGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);

    await harness.command('/newgame');

    expect(harness.lastMessage()).toContain('Нет активных шаблонов');
  });

  it('rejects a template button after the template is archived', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    const staleTemplate = harness.dataFor('Среда вечером');
    templates.archive(templates.active(firstGroupId)[0]!.id);

    await expect(harness.callback(staleTemplate)).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain('Шаблон больше недоступен');
    const draft = await drafts.load(firstGroupId, actorUserId);
    expect(draft).toMatchObject({ step: 'TEMPLATE' });
    expect(draft?.snapshot).toBeUndefined();
  });

  it('rejects replayed controls from an older draft view without mutation', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    const stalePreview = harness.dataFor('Предпросмотр');
    await harness.click('Количество мест');

    await harness.callback(stalePreview);

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'CUSTOMIZE',
      editingField: 'CAPACITY',
    });
  });

  it('renders a stale-control response when cancellation wins the publish race', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    publisher.beforeExecute = async () => {
      const current = await drafts.load(firstGroupId, actorUserId);
      await drafts.compareAndSet({
        ...current!,
        viewRevision: (current!.viewRevision ?? 0) + 1,
        cancelPending: true,
      });
    };

    await expect(harness.click('Опубликовать')).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'PREVIEW',
      cancelPending: true,
    });
  });

  it('renders a stale-control response when deletion wins the publish race', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    publisher.beforeExecute = async () => {
      await drafts.clear(firstGroupId);
    };

    await expect(harness.click('Опубликовать')).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'TEMPLATE',
    });
  });

  it('keeps a concurrently published draft when restart loses its exact-view race', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    await harness.command('/newgame');
    const restartData = harness.dataFor('Начать заново');
    drafts.beforeReplace = async (expected) => {
      drafts.publish({
        groupId: firstGroupId,
        actorUserId,
        draftId: expected!.draftId,
        expectedStep: expected!.step,
        expectedViewRevision: expected!.viewRevision,
        now: new Date('2026-09-05T12:00:00.000Z'),
      });
    };

    await expect(harness.callback(restartData)).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      step: 'PUBLISHED',
      publishedGameId: '40000000-0000-4000-8000-000000000001',
    });
  });

  it('renders an authorization loss in Russian without escaping the webhook', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    const error = new Error('Organizer role is required');
    error.name = 'AuthorizationDeniedError';
    publisher.nextError = error;

    await expect(harness.click('Опубликовать')).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain('нет прав администратора');
  });

  it('keeps the timing editor open when the complete resulting snapshot is invalid', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');

    await harness.click('Открытие регистрации');
    await harness.text('30');
    expect(harness.lastMessage()).toContain(
      'Закрытие не может быть раньше открытия регистрации.',
    );
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      editingField: 'OPENING',
      snapshot: { registrationOpensMinutesBefore: 1_440 },
    });

    await harness.text('1440');
    await harness.click('Запрос подтверждения');
    await harness.text('30');
    expect(harness.lastMessage()).toContain(
      'Время на ответ не может превышать срок запроса.',
    );
    expect(await drafts.load(firstGroupId, actorUserId)).toMatchObject({
      editingField: 'CONFIRMATION_PROMPT',
      snapshot: { tentativePromptMinutesBefore: 720 },
    });
  });

  it('renders typed template validation failures in Russian during publication', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    publisher.nextError = new TemplateInputError('CLOSING');

    await expect(harness.click('Опубликовать')).resolves.toBeUndefined();

    expect(harness.lastMessage()).toContain(
      'Проверьте все поля и снова откройте предпросмотр.',
    );
  });

  it('suppresses only Telegram message-not-modified failures on replay', async () => {
    organizer = new MemoryOrganizer([firstGroupId]);
    harness = createHarness(organizer, drafts, templates, publisher);
    await harness.command('/newgame');
    await harness.click('Среда вечером');
    await harness.text('10.09.2026');
    await harness.click('Предпросмотр');
    const publishData = harness.dataFor('Опубликовать');
    await harness.callback(publishData);
    const acknowledgements = harness.acknowledgementCount();
    harness.failNextEdit(
      400,
      'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    );

    await expect(harness.callback(publishData)).resolves.toBeUndefined();

    expect(harness.acknowledgementCount()).toBe(acknowledgements + 1);

    harness.failNextEdit(500, 'Internal Server Error');
    await expect(harness.callback(publishData)).rejects.toThrow();
  });

  it('cedes private text when another persisted flow owns the actor', async () => {
    let current: Awaited<ReturnType<OrganizerTextFlowCoordinator['current']>> =
      null;
    const flows: OrganizerTextFlowCoordinator = {
      claim: async (input) =>
        (current = {
          ...input,
          reference: input.reference ?? null,
          updatedAt: new Date(),
        }),
      current: async () => current,
      release: async () => {
        current = null;
        return true;
      },
    };
    harness = createHarness(organizer, drafts, templates, publisher, flows);
    await harness.command('/newgame');
    await harness.click('Команда 1');
    expect(current).toMatchObject({ kind: 'GAME_CREATION' });
    current = {
      groupId: firstGroupId,
      actorUserId,
      kind: 'TEMPLATE',
      reference: 'template-draft',
      updatedAt: new Date(),
    };

    await harness.text('10.09.2026');
    expect(harness.fallbackCount()).toBe(1);
  });
});

class MemoryDrafts implements GameCreationDraftRepository {
  private drafts = new Map<string, GameCreationDraft>();
  beforeReplace?: (
    expected:
      | {
          draftId: string;
          step: GameCreationDraft['step'];
          viewRevision: number;
        }
      | null
      | undefined,
  ) => Promise<void>;

  async load(
    groupId: GroupId,
    _actorUserId?: typeof actorUserId,
  ): Promise<GameCreationDraft | null> {
    void _actorUserId;
    const draft = this.drafts.get(groupId);
    return draft === undefined ? null : structuredClone(draft);
  }

  async replaceForNewFlow(
    draft: GameCreationDraft,
    expected?: {
      draftId: string;
      step: GameCreationDraft['step'];
      viewRevision: number;
    } | null,
  ) {
    if (this.beforeReplace !== undefined) {
      const beforeReplace = this.beforeReplace;
      this.beforeReplace = undefined;
      await beforeReplace(expected);
    }
    const current = this.drafts.get(draft.groupId);
    if (
      (expected === null && current !== undefined) ||
      (expected !== null &&
        expected !== undefined &&
        (current === undefined ||
          current.draftId !== expected.draftId ||
          current.step !== expected.step ||
          (current.viewRevision ?? 0) !== expected.viewRevision))
    ) {
      return 'STALE' as const;
    }
    this.drafts.set(draft.groupId, structuredClone(draft));
    return 'SAVED' as const;
  }

  async compareAndSet(draft: GameCreationDraft) {
    const current = this.drafts.get(draft.groupId);
    if (
      current === undefined ||
      current.draftId !== draft.draftId ||
      current.step === 'PUBLISHED' ||
      (draft.viewRevision !== undefined &&
        (current.viewRevision ?? 0) !== draft.viewRevision - 1)
    ) {
      return 'STALE' as const;
    }
    this.drafts.set(draft.groupId, structuredClone(draft));
    return 'SAVED' as const;
  }

  async clear(groupId: GroupId): Promise<void> {
    this.drafts.delete(groupId);
  }

  publish(command: PublishGameCommand): GameCreationDraft {
    const current = this.drafts.get(command.groupId);
    if (
      current === undefined ||
      current.draftId !== command.draftId ||
      (current.step !== command.expectedStep &&
        !(
          current.step === 'PUBLISHED' && command.expectedStep === 'PREVIEW'
        )) ||
      (current.viewRevision ?? 0) !== command.expectedViewRevision ||
      current.cancelPending === true
    ) {
      throw new Error('stale');
    }
    if (current.step !== 'PUBLISHED') {
      this.drafts.set(command.groupId, {
        ...current,
        step: 'PUBLISHED',
        cancelPending: false,
        publishedGameId: asGameId('40000000-0000-4000-8000-000000000001'),
      });
    }
    return this.drafts.get(command.groupId)!;
  }
}

class MemoryPublisher {
  nextError?: Error;
  beforeExecute?: (command: PublishGameCommand) => Promise<void>;

  constructor(private readonly drafts: MemoryDrafts) {}

  async execute(command: PublishGameCommand) {
    if (this.beforeExecute !== undefined) {
      const beforeExecute = this.beforeExecute;
      this.beforeExecute = undefined;
      await beforeExecute(command);
    }
    if (this.nextError !== undefined) {
      const error = this.nextError;
      this.nextError = undefined;
      throw error;
    }
    const before = await this.drafts.load(command.groupId, command.actorUserId);
    const draft = this.drafts.publish(command);
    const created = before?.step !== 'PUBLISHED';
    return {
      game: {
        ...createGameFromTemplate(
          draft.snapshot!,
          new Date(draft.startsAtIso!),
          'Europe/Astrakhan',
        ),
        id: draft.publishedGameId,
        groupId: draft.groupId,
        sourceTemplateId: draft.templateId ?? null,
        state: 'SCHEDULED' as const,
      },
      created,
    };
  }
}

class MemoryTemplates {
  private readonly items: GameTemplate[] = [];

  seed(groupId: GroupId, name: string): GameTemplate {
    const template: GameTemplate = {
      ...defaultSnapshot(name),
      id: asGameTemplateId('30000000-0000-4000-8000-000000000001'),
      groupId,
      revision: 1,
      archivedAt: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    };
    this.items.push(template);
    return template;
  }

  active(groupId: GroupId): GameTemplate[] {
    return this.items.filter(
      (item) => item.groupId === groupId && item.archivedAt === null,
    );
  }

  archive(id: GameTemplateId): void {
    this.items.find((item) => item.id === id)!.archivedAt = new Date();
  }

  async list(input: { groupId: GroupId }) {
    return { items: this.active(input.groupId), nextCursor: null };
  }

  async findById(groupId: GroupId, templateId: GameTemplateId) {
    return (
      this.items.find(
        (item) => item.groupId === groupId && item.id === templateId,
      ) ?? null
    );
  }
}

class MemoryOrganizer {
  listCalls = 0;
  private selected?: GroupId;

  constructor(private readonly groupIds: readonly GroupId[]) {}

  async list(): Promise<readonly OrganizerGroupCandidate[]> {
    this.listCalls += 1;
    return this.groupIds.map((groupId, index) => ({
      groupId,
      telegramChatId: asTelegramId(`-${1000 + index}`),
      title: `Команда ${index + 1}`,
      timeZone: 'Europe/Astrakhan',
      selected: groupId === this.selected,
    }));
  }

  async select(_telegramUserId: TelegramId, groupId: GroupId) {
    this.selected = groupId;
    return this.context(groupId);
  }

  async require(): Promise<OrganizerContext> {
    if (this.selected !== undefined) return this.context(this.selected);
    if (this.groupIds.length === 1) return this.context(this.groupIds[0]!);
    const error = new Error('Select an organizer group');
    error.name = 'OrganizerGroupSelectionRequiredError';
    throw error;
  }

  private context(groupId: GroupId): OrganizerContext {
    const index = this.groupIds.indexOf(groupId);
    return {
      groupId,
      userId: actorUserId,
      telegramChatId: asTelegramId(`-${1000 + index}`),
      title: `Команда ${index + 1}`,
      timeZone: 'Europe/Astrakhan',
    };
  }
}

const defaultSnapshot = (name: string): GameTemplateSnapshot => ({
  name,
  venue: 'Зал № 1',
  address: null,
  startsAtLocalTime: '19:00',
  durationMinutes: 120,
  capacity: 18,
  registrationOpensMinutesBefore: 1_440,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 720,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
});

const createHarness = (
  organizerContext: GameCreationOrganizerContext,
  draftRepository: GameCreationDraftRepository,
  templateRepository: GameCreationTemplates,
  publishGame: GameCreationHandlerOptions['publishGame'],
  textFlows?: OrganizerTextFlowCoordinator,
  defaults?: GameCreationDefaults,
) => {
  const handlers = new GameCreationHandlers({
    organizerContext,
    drafts: draftRepository,
    templates: templateRepository,
    publishGame,
    clock: () => new Date('2026-09-05T12:00:00.000Z'),
    textFlows,
    defaults,
  });
  const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
  const messages: Array<{
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  let updateId = 1;
  let fallback = 0;
  let acknowledgements = 0;
  let nextEditFailure: { errorCode: number; description: string } | undefined;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage' || method === 'editMessageText') {
      if (method === 'editMessageText' && nextEditFailure !== undefined) {
        const failure = nextEditFailure;
        nextEditFailure = undefined;
        return {
          ok: false,
          error_code: failure.errorCode,
          description: failure.description,
        } as never;
      }
      const candidate = payload as {
        text: string;
        reply_markup?: {
          inline_keyboard?: (typeof messages)[number]['keyboard'];
        };
      };
      messages.push({
        text: candidate.text,
        keyboard: candidate.reply_markup?.inline_keyboard ?? [],
      });
      return { ok: true, result: {} } as never;
    }
    if (method === 'answerCallbackQuery') {
      acknowledgements += 1;
      return { ok: true, result: true } as never;
    }
    return { ok: true, result: {} } as never;
  });
  registerGameCreationHandlers(bot, handlers);
  bot.on('message:text', () => {
    fallback += 1;
  });

  const handle = (update: Update) => bot.handleUpdate(update);
  const command = (text: string) =>
    handle({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: 42, type: 'private', first_name: 'Admin' },
        from: { id: 42, is_bot: false, first_name: 'Admin' },
        text,
        entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
      },
    });
  const text = (value: string) =>
    handle({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id: 42, type: 'private', first_name: 'Admin' },
        from: { id: 42, is_bot: false, first_name: 'Admin' },
        text: value,
      },
    });
  const callback = (data: string) =>
    handle({
      update_id: updateId++,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: 'chat',
        from: { id: 42, is_bot: false, first_name: 'Admin' },
        data,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 42, type: 'private', first_name: 'Admin' },
        },
      },
    });
  const buttons = () =>
    messages
      .at(-1)
      ?.keyboard.flat()
      .map((button) => button.text) ?? [];
  const dataFor = (label: string) => {
    const button = messages
      .at(-1)
      ?.keyboard.flat()
      .find((candidate) => candidate.text === label);
    if (button === undefined) throw new Error(`Missing button: ${label}`);
    return button.callback_data;
  };

  return {
    command,
    text,
    callback,
    click: (label: string) => callback(dataFor(label)),
    dataFor,
    buttons,
    callbackData: () =>
      messages.flatMap((message) =>
        message.keyboard.flat().map((button) => button.callback_data),
      ),
    lastMessage: () => messages.at(-1)?.text ?? '',
    visibleText: () => messages.map((message) => message.text).join('\n'),
    fallbackCount: () => fallback,
    acknowledgementCount: () => acknowledgements,
    failNextEdit: (errorCode: number, description: string) => {
      nextEditFailure = { errorCode, description };
    },
  };
};
