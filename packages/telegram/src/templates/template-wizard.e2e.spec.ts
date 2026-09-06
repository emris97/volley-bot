import {
  OrganizerGroupSelectionRequiredError,
  type OrganizerContext,
} from '@volley/application';
import {
  asGameTemplateId,
  asGroupId,
  asTelegramId,
  asUserId,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
} from '@volley/domain';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  TemplateWizardDraft,
  TemplateWizardDraftStore,
} from './template-wizard.model.js';
import {
  registerTemplateWizardHandlers,
  TemplateWizardHandlers,
  type TemplateWizardServices,
} from './template-wizard.handlers.js';

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
const telegramUserId = asTelegramId('42');
const groupId = asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424600');
const actorUserId = asUserId('018f6ba0-62d2-7bd1-8f13-12e0c8424601');

describe('template wizard Telegram flow', () => {
  let drafts: MemoryDrafts;
  let templates: MemoryTemplates;
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    drafts = new MemoryDrafts();
    templates = new MemoryTemplates();
    harness = createHarness(drafts, templates);
  });

  it('persists and resumes creation through preview and save', async () => {
    await harness.command('/templates');
    expect(harness.lastMessage()).toContain('Шаблоны');
    await harness.click('Создать шаблон');
    await harness.text('Среда вечером');
    await harness.text('Спортзал № 1');

    harness = createHarness(drafts, templates);
    await harness.command('/templates');
    expect(harness.lastMessage()).toContain('Адрес');

    await harness.text('ул. Мира, 1');
    await harness.text('99:99');
    expect(harness.lastMessage()).toContain('Введите время в формате');
    await harness.text('19:30');
    await harness.text('120');
    await harness.text('18');
    await harness.text('1440');
    await harness.text('60');
    await harness.text('120');
    await harness.text('60');
    await harness.text('30');
    const stalePriority = harness.dataFor('Да');
    await harness.click('Да');
    await harness.callback(stalePriority);
    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect((await drafts.load(groupId, actorUserId))?.step).toBe('COST');
    await harness.text('1250,50');
    await harness.click('Точно до копеек');

    expect(harness.lastMessage()).toContain('<b>Проверьте шаблон</b>');
    await harness.click('Сохранить');
    expect(templates.active()).toHaveLength(1);
    expect(templates.active()[0]).toMatchObject({
      name: 'Среда вечером',
      defaultTotalCostMinor: 125050n,
    });
    expect(await drafts.load(groupId, actorUserId)).toBeNull();
  });

  it('supports back, confirmed cancellation, copy, stale edit, archive and restore', async () => {
    const original = templates.seed('Вторник', false);
    await harness.command('/templates');
    await harness.click('Вторник');
    await harness.click('Копировать');
    await harness.text('Вторник поздно');
    await harness.click('Назад');
    expect(harness.lastMessage()).toContain('Название');
    await harness.click('Отмена');
    expect(harness.lastMessage()).toContain('Отменить создание шаблона?');
    await harness.click('Да, отменить');
    expect(await drafts.load(groupId, actorUserId)).toBeNull();

    await harness.command('/templates');
    await harness.click('Вторник');
    await harness.click('Копировать');
    await harness.text('Вторник поздно');
    await completeFromVenue(harness);
    await harness.click('Сохранить');
    expect(templates.active().map((item) => item.name)).toContain(
      'Вторник поздно',
    );

    await harness.command('/templates');
    await harness.click('Вторник');
    await harness.click('Изменить');
    templates.bump(original.id);
    await completeEdit(harness);
    await harness.click('Сохранить');
    expect(harness.lastMessage()).toContain('изменён другим администратором');

    await harness.command('/templates');
    await harness.click('Вторник');
    const staleArchive = harness.dataFor('В архив');
    await harness.click('В архив');
    expect(templates.active().some((item) => item.name === 'Вторник')).toBe(
      false,
    );
    const acknowledgementsBefore = harness.acknowledgementCount();
    await harness.callback(staleArchive);
    expect(harness.lastMessage()).toContain('изменён другим администратором');
    expect(harness.acknowledgementCount() - acknowledgementsBefore).toBe(1);
    await harness.click('Архив');
    await harness.click('Вторник');
    await harness.click('Восстановить');
    expect(templates.active().some((item) => item.name === 'Вторник')).toBe(
      true,
    );
  });

  it('renders exactly eight templates per page without visible raw UUIDs', async () => {
    for (let index = 1; index <= 10; index += 1) {
      templates.seed(`Шаблон ${index.toString().padStart(2, '0')}`, false);
    }
    await harness.command('/templates');

    expect(
      harness.buttons().filter((button) => button.startsWith('Шаблон')),
    ).toHaveLength(8);
    expect(harness.lastMessage()).not.toMatch(
      /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i,
    );
    expect(
      harness
        .callbackData()
        .filter((data) => data.startsWith('tw:'))
        .every((data) => {
          return (
            data.startsWith('tw:v1:') && Buffer.byteLength(data, 'utf8') < 64
          );
        }),
    ).toBe(true);

    await harness.click('Далее');
    expect(
      harness.buttons().filter((button) => button.startsWith('Шаблон')),
    ).toHaveLength(2);
  });

  it('passes unowned text and commands to later middleware', async () => {
    await harness.text('не относится к мастеру');
    await harness.command('/unknown');
    expect(harness.fallbackCount()).toBe(2);
  });

  it('does not let an old list control replace an active draft', async () => {
    await harness.command('/templates');
    const staleCreate = harness.dataFor('Создать шаблон');
    await harness.callback(staleCreate);
    await harness.text('Текущий шаблон');

    await harness.callback(staleCreate);

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(groupId, actorUserId)).toMatchObject({
      step: 'VENUE',
      snapshot: { name: 'Текущий шаблон' },
    });
    expect(
      harness
        .callbackData()
        .filter((data) => data.startsWith('tw:'))
        .every(
          (data) =>
            /^tw:v1:[a-z0-9-]+:[0-9a-f]{32}\.[a-z]\.[0-9a-z]+$/.test(data) &&
            Buffer.byteLength(data, 'utf8') < 64,
        ),
    ).toBe(true);
  });

  it.each(['Изменить', 'Копировать'])(
    'does not let an old %s control replace an active draft',
    async (action) => {
      templates.seed('Исходный', false);
      await harness.command('/templates');
      await harness.click('Исходный');
      const staleAction = harness.dataFor(action);
      const currentDraft: TemplateWizardDraft = {
        version: 1,
        mode: 'CREATE',
        step: 'CAPACITY',
        draftId: '018f6ba062d27bd18f1312e0c8424688',
        viewRevision: 3,
        snapshot: {
          name: 'Текущий',
          venue: 'Зал',
          address: null,
          startsAtLocalTime: '19:00',
          durationMinutes: 90,
        },
        previewed: false,
      };
      await drafts.save(groupId, actorUserId, currentDraft);

      await harness.callback(staleAction);

      expect(harness.lastMessage()).toContain('кнопка устарела');
      expect(await drafts.load(groupId, actorUserId)).toEqual(currentDraft);
    },
  );

  it('rejects an old cancel confirmation after returning to the same step', async () => {
    await harness.command('/templates');
    await harness.click('Создать шаблон');
    await harness.click('Отмена');
    const staleCancelConfirmation = harness.dataFor('Да, отменить');
    await harness.click('Нет');

    await harness.callback(staleCancelConfirmation);

    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(await drafts.load(groupId, actorUserId)).toMatchObject({
      mode: 'CREATE',
      step: 'NAME',
    });
  });

  it('passes idle text onward when no organizer context can be resolved', async () => {
    harness = createHarness(drafts, templates, {
      require: async () => {
        throw new OrganizerGroupSelectionRequiredError();
      },
      list: async () => [],
    });

    await expect(harness.text('обычное сообщение')).resolves.toBeUndefined();
    expect(harness.fallbackCount()).toBe(1);
  });

  it('renders a group picker for /templates with multiple live groups and no selection', async () => {
    harness = createHarness(drafts, templates, {
      require: async () => {
        throw new OrganizerGroupSelectionRequiredError();
      },
      list: async () => [
        {
          groupId,
          telegramChatId: asTelegramId('-1005000'),
          title: 'Volley',
          timeZone: 'Europe/Moscow',
          selected: false,
        },
        {
          groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424622'),
          telegramChatId: asTelegramId('-1005001'),
          title: 'Beach Volley',
          timeZone: 'Europe/Moscow',
          selected: false,
        },
      ],
    });

    await expect(harness.command('/templates')).resolves.toBeUndefined();
    expect(harness.lastMessage()).toContain('Выберите группу');
  });

  it('renders an expected Russian view for stale wizard controls', async () => {
    await expect(
      harness.callback(`tw:v1:save:${'0'.repeat(32)}`),
    ).resolves.toBeUndefined();
    expect(harness.lastMessage()).toContain('кнопка устарела');
    expect(harness.acknowledgementCount()).toBe(1);
  });

  it('preserves a draft created while an archive action becomes stale', async () => {
    const template = templates.seed('Гонка архива', false);
    await harness.command('/templates');
    await harness.click('Гонка архива');
    const archive = harness.dataFor('В архив');
    const concurrentDraft: TemplateWizardDraft = {
      version: 1,
      mode: 'CREATE',
      step: 'VENUE',
      draftId: '018f6ba062d27bd18f1312e0c8424699',
      viewRevision: 2,
      snapshot: { name: 'Не удалять' },
      previewed: false,
    };
    templates.beforeSetArchived = async () => {
      await drafts.save(groupId, actorUserId, concurrentDraft);
      templates.bump(template.id);
    };

    await harness.callback(archive);

    expect(harness.lastMessage()).toContain('изменён другим администратором');
    expect(await drafts.load(groupId, actorUserId)).toEqual(concurrentDraft);
  });
});

const completeFromVenue = async (harness: ReturnType<typeof createHarness>) => {
  await harness.text('Зал');
  await harness.text('-');
  await harness.text('20:00');
  await harness.text('90');
  await harness.text('20');
  await harness.text('1440');
  await harness.text('-');
  await harness.text('120');
  await harness.text('60');
  await harness.text('30');
  await harness.click('Нет');
  await harness.text('-');
  await harness.click('До 10 ₽ вверх');
};

const completeEdit = async (harness: ReturnType<typeof createHarness>) => {
  await harness.text('Вторник обновлён');
  await completeFromVenue(harness);
};

class MemoryDrafts implements TemplateWizardDraftStore {
  private draft: TemplateWizardDraft | null = null;

  async load(
    _groupId: typeof groupId,
    _actorUserId: typeof actorUserId,
  ): Promise<TemplateWizardDraft | null> {
    void _groupId;
    void _actorUserId;
    return this.draft === null ? null : structuredClone(this.draft);
  }

  async save(
    _groupId: typeof groupId,
    _actorUserId: typeof actorUserId,
    draft: TemplateWizardDraft,
  ): Promise<void> {
    this.draft = structuredClone(draft);
  }

  async clear(
    _groupId: typeof groupId,
    _actorUserId: typeof actorUserId,
  ): Promise<void> {
    void _groupId;
    void _actorUserId;
    this.draft = null;
  }
}

class MemoryTemplates implements TemplateWizardServices {
  private readonly items: GameTemplate[] = [];
  private serial = 16;
  beforeSetArchived?: () => Promise<void>;

  active(): GameTemplate[] {
    return this.items.filter((item) => item.archivedAt === null);
  }

  seed(
    name: string,
    archived: boolean,
    snapshot?: GameTemplateSnapshot,
  ): GameTemplate {
    const hex = this.serial.toString(16).padStart(12, '0');
    this.serial += 1;
    const now = new Date('2026-09-06T00:00:00.000Z');
    const item: GameTemplate = {
      id: asGameTemplateId(`018f6ba0-62d2-7bd1-8f13-${hex}`),
      groupId,
      ...(snapshot ?? defaultSnapshot(name)),
      revision: 1,
      archivedAt: archived ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    return item;
  }

  bump(id: GameTemplateId): void {
    const item = this.items.find((candidate) => candidate.id === id)!;
    item.revision += 1;
  }

  async findById(_groupId: typeof groupId, id: GameTemplateId) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  async list(input: {
    archived: boolean;
    limit: number;
    afterId?: GameTemplateId | null;
  }) {
    const matching = this.items
      .filter((item) => (item.archivedAt !== null) === input.archived)
      .sort((left, right) => left.name.localeCompare(right.name));
    const start =
      input.afterId == null
        ? 0
        : matching.findIndex((item) => item.id === input.afterId) + 1;
    const items = matching.slice(start, start + input.limit);
    return {
      items,
      nextCursor:
        start + input.limit < matching.length ? items.at(-1)!.id : null,
    };
  }

  async create(snapshot: GameTemplateSnapshot) {
    return this.seed(snapshot.name, false, snapshot);
  }

  async update(input: {
    templateId: GameTemplateId;
    expectedRevision: number;
    snapshot: GameTemplateSnapshot;
  }) {
    const item = this.items.find(
      (candidate) => candidate.id === input.templateId,
    );
    if (item === undefined || item.revision !== input.expectedRevision) {
      const error = new Error('Template revision is stale');
      error.name = 'TemplateRevisionConflictError';
      throw error;
    }
    Object.assign(item, input.snapshot, { revision: item.revision + 1 });
    return item;
  }

  async setArchived(input: {
    templateId: GameTemplateId;
    expectedRevision: number;
    archived: boolean;
  }) {
    await this.beforeSetArchived?.();
    this.beforeSetArchived = undefined;
    const item = this.items.find(
      (candidate) => candidate.id === input.templateId,
    );
    if (item === undefined || item.revision !== input.expectedRevision) {
      const error = new Error('Template revision is stale');
      error.name = 'TemplateRevisionConflictError';
      throw error;
    }
    item.archivedAt = input.archived ? new Date('2026-09-06T00:00:00Z') : null;
    item.revision += 1;
    return item;
  }
}

const defaultSnapshot = (name: string): GameTemplateSnapshot => ({
  name,
  venue: 'Зал',
  address: null,
  startsAtLocalTime: '20:00',
  durationMinutes: 90,
  capacity: 20,
  registrationOpensMinutesBefore: 1440,
  registrationClosesMinutesBefore: null,
  tentativePromptMinutesBefore: 120,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 30,
  memberPriorityEnabled: false,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
});

const createHarness = (
  drafts: MemoryDrafts,
  templates: MemoryTemplates,
  organizerContext?: ConstructorParameters<typeof TemplateWizardHandlers>[0],
) => {
  const context: OrganizerContext = {
    groupId,
    userId: actorUserId,
    telegramChatId: asTelegramId('-1005000'),
    title: 'Volley',
    timeZone: 'Europe/Moscow',
  };
  const handler = new TemplateWizardHandlers(
    organizerContext ?? {
      require: async () => context,
      list: async () => [
        {
          groupId,
          telegramChatId: context.telegramChatId,
          title: context.title,
          timeZone: context.timeZone,
          selected: true,
        },
      ],
    },
    drafts,
    templates,
  );
  const bot = new Bot('123456:abcdefghijklmnopqrstuvwxyz', { botInfo });
  const messages: Array<{
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  }> = [];
  let updateId = 1;
  let fallback = 0;
  let acknowledgements = 0;
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'sendMessage' || method === 'editMessageText') {
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
    }
    if (method === 'answerCallbackQuery') acknowledgements += 1;
    return {
      ok: true,
      result: method === 'sendMessage' ? messageResult() : true,
    } as never;
  });
  registerTemplateWizardHandlers(bot, handler);
  bot.on('message:text', () => {
    fallback += 1;
  });

  const handle = (update: Update) => bot.handleUpdate(update);
  return {
    command(text: string) {
      return handle(messageUpdate(text, true, updateId++));
    },
    text(text: string) {
      return handle(messageUpdate(text, false, updateId++));
    },
    async click(text: string) {
      const button = messages
        .at(-1)
        ?.keyboard.flat()
        .find((item) => item.text === text);
      if (button === undefined) throw new Error(`Button ${text} missing`);
      await handle(callbackUpdate(button.callback_data, updateId++));
    },
    lastMessage: () => messages.at(-1)?.text ?? '',
    buttons: () =>
      messages
        .at(-1)
        ?.keyboard.flat()
        .map((button) => button.text) ?? [],
    callbackData: () =>
      messages
        .at(-1)
        ?.keyboard.flat()
        .map((button) => button.callback_data) ?? [],
    dataFor: (text: string) => {
      const button = messages
        .at(-1)
        ?.keyboard.flat()
        .find((item) => item.text === text);
      if (button === undefined) throw new Error(`Button ${text} missing`);
      return button.callback_data;
    },
    callback(data: string) {
      return handle(callbackUpdate(data, updateId++));
    },
    fallbackCount: () => fallback,
    acknowledgementCount: () => acknowledgements,
  };
};

const messageResult = () => ({
  message_id: 1,
  date: 1_788_134_400,
  chat: {
    id: Number(telegramUserId),
    type: 'private' as const,
    first_name: 'Admin',
  },
  text: 'ok',
});

const messageUpdate = (
  text: string,
  command: boolean,
  updateId: number,
): Update => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_788_134_400,
    chat: { id: Number(telegramUserId), type: 'private', first_name: 'Admin' },
    from: { id: Number(telegramUserId), is_bot: false, first_name: 'Admin' },
    text,
    ...(command
      ? { entities: [{ offset: 0, length: text.length, type: 'bot_command' }] }
      : {}),
  },
});

const callbackUpdate = (data: string, updateId: number): Update => ({
  update_id: updateId,
  callback_query: {
    id: String(updateId),
    chat_instance: 'test',
    from: { id: Number(telegramUserId), is_bot: false, first_name: 'Admin' },
    data,
    message: {
      message_id: updateId,
      date: 1_788_134_400,
      chat: {
        id: Number(telegramUserId),
        type: 'private',
        first_name: 'Admin',
      },
      text: 'templates',
    },
  },
});
