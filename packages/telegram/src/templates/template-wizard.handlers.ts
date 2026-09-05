import { randomUUID } from 'node:crypto';
import {
  OrganizerGroupSelectionRequiredError,
  type OrganizerContext,
} from '@volley/application';
import {
  asGameTemplateId,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';
import {
  nextTemplateStep,
  previousTemplateStep,
} from '../organizer/settings-editor.model.js';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import {
  parseInteger,
  parseLocalTime,
  parseRubles,
  parseUnicodeText,
  type ParseError,
} from '../organizer/input.parsers.js';
import {
  parseTemplateDraftControlId,
  type TemplateWizardDraft,
  type TemplateWizardDraftStore,
} from './template-wizard.model.js';
import {
  expandUuid,
  renderCancelConfirmation,
  renderTemplateDetails,
  renderTemplateList,
  renderTemplateWizard,
} from './template-wizard.presenter.js';

export interface TemplateWizardOrganizerContext {
  require(telegramUserId: TelegramId): Promise<OrganizerContext>;
}

export interface TemplateWizardServices {
  findById(
    groupId: GroupId,
    templateId: GameTemplateId,
  ): Promise<GameTemplate | null>;
  list(input: {
    groupId: GroupId;
    archived: boolean;
    limit: number;
    afterId?: GameTemplateId | null;
  }): Promise<{
    items: readonly GameTemplate[];
    nextCursor: GameTemplateId | null;
  }>;
  create(
    snapshot: GameTemplateSnapshot,
    context: OrganizerContext,
  ): Promise<GameTemplate>;
  update(input: {
    groupId: GroupId;
    actorUserId: UserId;
    templateId: GameTemplateId;
    expectedRevision: number;
    snapshot: GameTemplateSnapshot;
  }): Promise<GameTemplate>;
  setArchived(input: {
    groupId: GroupId;
    actorUserId: UserId;
    templateId: GameTemplateId;
    expectedRevision: number;
    archived: boolean;
  }): Promise<GameTemplate>;
}

export class TemplateWizardHandlers {
  public constructor(
    private readonly organizerContext: TemplateWizardOrganizerContext,
    private readonly drafts: TemplateWizardDraftStore,
    private readonly templates: TemplateWizardServices,
  ) {}

  public async open(telegramUserId: TelegramId): Promise<OrganizerView> {
    const actor = await this.organizerContext.require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    return draft === null
      ? this.listFor(actor, false)
      : renderTemplateWizard(draft);
  }

  public async list(
    telegramUserId: TelegramId,
    archived = false,
    afterId?: GameTemplateId | null,
  ): Promise<OrganizerView> {
    return this.listFor(
      await this.organizerContext.require(telegramUserId),
      archived,
      afterId,
    );
  }

  public async startCreate(telegramUserId: TelegramId): Promise<OrganizerView> {
    const actor = await this.organizerContext.require(telegramUserId);
    const draft: TemplateWizardDraft = {
      version: 1,
      mode: 'CREATE',
      step: 'NAME',
      draftId: randomUUID().replaceAll('-', ''),
      snapshot: {},
      previewed: false,
    };
    await this.save(actor, draft);
    return renderTemplateWizard(draft);
  }

  public async startEdit(
    telegramUserId: TelegramId,
    templateId: GameTemplateId,
  ): Promise<OrganizerView> {
    const actor = await this.organizerContext.require(telegramUserId);
    const template = await this.templates.findById(actor.groupId, templateId);
    if (template === null)
      return this.listFor(
        actor,
        false,
        undefined,
        'Шаблон больше не существует.',
      );
    const draft: TemplateWizardDraft = {
      version: 1,
      mode: 'EDIT',
      step: 'NAME',
      draftId: randomUUID().replaceAll('-', ''),
      templateId,
      expectedRevision: template.revision,
      snapshot: snapshotOf(template),
      previewed: false,
    };
    await this.save(actor, draft);
    return renderTemplateWizard(draft);
  }

  public async startCopy(
    telegramUserId: TelegramId,
    templateId: GameTemplateId,
  ): Promise<OrganizerView> {
    const actor = await this.organizerContext.require(telegramUserId);
    const template = await this.templates.findById(actor.groupId, templateId);
    if (template === null)
      return this.listFor(
        actor,
        false,
        undefined,
        'Шаблон больше не существует.',
      );
    const draft: TemplateWizardDraft = {
      version: 1,
      mode: 'COPY',
      step: 'NAME',
      draftId: randomUUID().replaceAll('-', ''),
      templateId,
      snapshot: { ...snapshotOf(template), name: `${template.name} — копия` },
      previewed: false,
    };
    await this.save(actor, draft);
    return renderTemplateWizard(draft);
  }

  public async handleCallback(
    telegramUserId: TelegramId,
    data: string,
  ): Promise<OrganizerView> {
    const actor = await this.organizerContext.require(telegramUserId);
    const callback = parseCallback(data);
    if (callback === null)
      return this.currentOrList(actor, 'Эта кнопка больше не действует.');
    const currentDraft = await this.drafts.load(actor.groupId, actor.userId);
    if (staticActions.has(callback.action) && currentDraft !== null) {
      return renderTemplateWizard(currentDraft, staleControlText);
    }

    try {
      if (callback.action === 'create') return this.startCreate(telegramUserId);
      if (callback.action === 'active') return this.listFor(actor, false);
      if (callback.action === 'archived') return this.listFor(actor, true);
      if (callback.action === 'next' || callback.action === 'next-archived') {
        const cursor = decodeTemplateId(callback.opaqueId);
        return cursor === null
          ? this.currentOrList(actor, 'Эта кнопка больше не действует.')
          : this.listFor(actor, callback.action === 'next-archived', cursor);
      }
      if (callback.action === 'open') {
        const template = await this.findCallbackTemplate(
          actor,
          callback.opaqueId,
        );
        return template === null
          ? this.listFor(
              actor,
              false,
              undefined,
              'Шаблон больше не существует.',
            )
          : renderTemplateDetails(template);
      }
      if (callback.action === 'edit' || callback.action === 'copy') {
        const templateId = decodeTemplateId(callback.opaqueId);
        if (templateId === null)
          return this.currentOrList(actor, 'Эта кнопка больше не действует.');
        return callback.action === 'edit'
          ? this.startEdit(telegramUserId, templateId)
          : this.startCopy(telegramUserId, templateId);
      }
      if (callback.action === 'archive' || callback.action === 'restore') {
        return await this.setArchived(
          actor,
          callback.opaqueId,
          callback.action === 'archive',
        );
      }

      const draft = currentDraft;
      const control = parseTemplateDraftControlId(callback.opaqueId);
      if (
        draft === null ||
        control === null ||
        control.draftId !== draft.draftId ||
        control.step !== draft.step
      ) {
        return this.currentOrList(actor, staleControlText);
      }
      if (callback.action === 'back') {
        const updated = {
          ...draft,
          step: previousTemplateStep(draft.step),
          previewed: false,
        };
        await this.save(actor, updated);
        return renderTemplateWizard(updated);
      }
      if (callback.action === 'cancel') return renderCancelConfirmation(draft);
      if (callback.action === 'resume') return renderTemplateWizard(draft);
      if (callback.action === 'cancel-confirm') {
        await this.drafts.clear(actor.groupId, actor.userId);
        return this.listFor(actor, false, undefined, 'Изменения отменены.');
      }
      if (
        callback.action === 'priority-yes' ||
        callback.action === 'priority-no'
      ) {
        if (draft.step !== 'MEMBER_PRIORITY')
          return renderTemplateWizard(draft, staleControlText);
        return this.mutate(actor, draft, {
          memberPriorityEnabled: callback.action === 'priority-yes',
        });
      }
      const rounding = roundingFor(callback.action);
      if (rounding !== null) {
        if (draft.step !== 'ROUNDING')
          return renderTemplateWizard(draft, staleControlText);
        return this.mutate(actor, draft, { roundingMode: rounding });
      }
      if (callback.action === 'save') {
        if (draft.step !== 'PREVIEW')
          return renderTemplateWizard(draft, staleControlText);
        return await this.saveTemplate(actor, draft);
      }
      return renderTemplateWizard(draft, 'Эта кнопка больше не действует.');
    } catch (error) {
      if (isExpectedTemplateError(error)) {
        if (error.name === 'TemplateRevisionConflictError') {
          if (callback.action === 'save' && currentDraft?.mode === 'EDIT') {
            const latest = await this.drafts.load(actor.groupId, actor.userId);
            if (latest?.draftId === currentDraft.draftId) {
              await this.drafts.clear(actor.groupId, actor.userId);
            }
          }
          const latest = await this.drafts.load(actor.groupId, actor.userId);
          const notice =
            'Шаблон изменён другим администратором. Откройте его заново.';
          return latest === null
            ? this.listFor(actor, false, undefined, notice)
            : renderTemplateWizard(latest, notice);
        }
        return this.currentOrList(actor, expectedErrorText(error));
      }
      throw error;
    }
  }

  public async handleText(
    telegramUserId: TelegramId,
    text: string,
  ): Promise<OrganizerView | false> {
    if (text.startsWith('/')) return false;
    let actor: OrganizerContext;
    try {
      actor = await this.organizerContext.require(telegramUserId);
    } catch (error) {
      if (error instanceof OrganizerGroupSelectionRequiredError) return false;
      throw error;
    }
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (draft === null) return false;
    const parsed = parseStepText(draft.step, text, draft.snapshot);
    if (parsed === null)
      return renderTemplateWizard(draft, 'Используйте кнопки под сообщением.');
    if ('error' in parsed)
      return renderTemplateWizard(draft, correctionText(parsed.error));
    return this.mutate(actor, draft, parsed);
  }

  private async mutate(
    actor: OrganizerContext,
    draft: TemplateWizardDraft,
    changes: Partial<GameTemplateSnapshot>,
  ): Promise<OrganizerView> {
    const step = nextTemplateStep(draft.step);
    const updated: TemplateWizardDraft = {
      ...draft,
      step,
      snapshot: { ...draft.snapshot, ...changes },
      previewed: step === 'PREVIEW',
    };
    await this.save(actor, updated);
    return renderTemplateWizard(updated);
  }

  private async saveTemplate(
    actor: OrganizerContext,
    draft: TemplateWizardDraft,
  ): Promise<OrganizerView> {
    const snapshot = completeSnapshot(draft.snapshot);
    if (snapshot === null || draft.step !== 'PREVIEW' || !draft.previewed)
      return renderTemplateWizard(
        draft,
        'Заполните все поля и снова проверьте шаблон.',
      );
    if (draft.mode === 'EDIT') {
      await this.templates.update({
        groupId: actor.groupId,
        actorUserId: actor.userId,
        templateId: draft.templateId!,
        expectedRevision: draft.expectedRevision!,
        snapshot,
      });
    } else {
      await this.templates.create(snapshot, actor);
    }
    await this.drafts.clear(actor.groupId, actor.userId);
    return this.listFor(actor, false, undefined, 'Шаблон сохранён.');
  }

  private async setArchived(
    actor: OrganizerContext,
    opaqueId: string | undefined,
    archived: boolean,
  ): Promise<OrganizerView> {
    const parsed = parseRevisionToken(opaqueId);
    if (parsed === null)
      return this.currentOrList(actor, 'Эта кнопка больше не действует.');
    await this.templates.setArchived({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      templateId: parsed.templateId,
      expectedRevision: parsed.revision,
      archived,
    });
    return this.listFor(
      actor,
      archived ? false : true,
      undefined,
      archived ? 'Шаблон перемещён в архив.' : 'Шаблон восстановлен.',
    );
  }

  private async findCallbackTemplate(
    actor: OrganizerContext,
    opaqueId: string | undefined,
  ): Promise<GameTemplate | null> {
    const templateId = decodeTemplateId(opaqueId);
    return templateId === null
      ? null
      : this.templates.findById(actor.groupId, templateId);
  }

  private async listFor(
    actor: OrganizerContext,
    archived: boolean,
    afterId?: GameTemplateId | null,
    notice?: string,
  ): Promise<OrganizerView> {
    const page = await this.templates.list({
      groupId: actor.groupId,
      archived,
      limit: 8,
      afterId,
    });
    return renderTemplateList({ ...page, archived, notice });
  }

  private async currentOrList(
    actor: OrganizerContext,
    notice: string,
  ): Promise<OrganizerView> {
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    return draft === null
      ? this.listFor(actor, false, undefined, notice)
      : renderTemplateWizard(draft, notice);
  }

  private save(
    actor: OrganizerContext,
    draft: TemplateWizardDraft,
  ): Promise<void> {
    return this.drafts.save(actor.groupId, actor.userId, draft);
  }
}

export const registerTemplateWizardHandlers = (
  bot: Bot<Context>,
  handlers: TemplateWizardHandlers,
): Bot<Context> => {
  bot.command('templates', async (context) => {
    if (context.from === undefined || context.chat.type !== 'private') return;
    await replyView(
      context,
      await handlers.open(toTelegramId(context.from.id)),
    );
  });
  bot.callbackQuery(/^tw:v1:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      await context.answerCallbackQuery();
      return;
    }
    try {
      const view = await handlers.handleCallback(
        toTelegramId(context.callbackQuery.from.id),
        context.callbackQuery.data,
      );
      await editView(context, view);
    } finally {
      await context.answerCallbackQuery();
    }
  });
  bot.on('message:text', async (context, next) => {
    if (
      context.from === undefined ||
      context.chat.type !== 'private' ||
      context.message.text.startsWith('/')
    ) {
      await next();
      return;
    }
    const view = await handlers.handleText(
      toTelegramId(context.from.id),
      context.message.text,
    );
    if (view === false) await next();
    else await replyView(context, view);
  });
  return bot;
};

const parseCallback = (
  data: string,
): { action: string; opaqueId?: string } | null => {
  const [namespace, version, action, opaqueId, ...rest] = data.split(':');
  if (
    namespace !== 'tw' ||
    version !== 'v1' ||
    action === undefined ||
    action.length === 0 ||
    rest.length > 0
  )
    return null;
  return { action, ...(opaqueId === undefined ? {} : { opaqueId }) };
};

const staticActions = new Set([
  'create',
  'active',
  'archived',
  'next',
  'next-archived',
  'open',
  'edit',
  'copy',
  'archive',
  'restore',
]);
const staleControlText = 'Эта кнопка устарела. Продолжите с текущего шага.';

const parseStepText = (
  step: TemplateWizardDraft['step'],
  text: string,
  snapshot: Partial<GameTemplateSnapshot>,
): Partial<GameTemplateSnapshot> | ParseError<string> | null => {
  if (step === 'NAME')
    return mapParsed(parseUnicodeText(text, 1, 80, 'NAME_LENGTH'), 'name');
  if (step === 'VENUE')
    return mapParsed(parseUnicodeText(text, 1, 120, 'VENUE_LENGTH'), 'venue');
  if (step === 'ADDRESS') {
    if (text.trim() === '-') return { address: null };
    return mapParsed(
      parseUnicodeText(text, 1, 300, 'ADDRESS_LENGTH'),
      'address',
    );
  }
  if (step === 'TIME')
    return mapParsed(parseLocalTime(text), 'startsAtLocalTime');
  if (step === 'DURATION')
    return mapParsed(
      parseInteger(text, 15, 720, 'DURATION_RANGE'),
      'durationMinutes',
    );
  if (step === 'CAPACITY')
    return mapParsed(parseInteger(text, 1, 200, 'CAPACITY_RANGE'), 'capacity');
  if (step === 'OPENING')
    return mapParsed(
      parseInteger(text, 0, 2_147_483_647, 'OPENING_RANGE'),
      'registrationOpensMinutesBefore',
    );
  if (step === 'CLOSING') {
    if (text.trim() === '-') return { registrationClosesMinutesBefore: null };
    const parsed = parseInteger(text, 0, 2_147_483_647, 'CLOSING_RANGE');
    if (isParseError(parsed)) return parsed;
    if (
      snapshot.registrationOpensMinutesBefore !== undefined &&
      parsed > snapshot.registrationOpensMinutesBefore
    )
      return { error: 'CLOSING_ORDER' };
    return { registrationClosesMinutesBefore: parsed };
  }
  if (step === 'CONFIRMATION_PROMPT')
    return mapParsed(
      parseInteger(text, 0, 2_147_483_647, 'CONFIRMATION_RANGE'),
      'tentativePromptMinutesBefore',
    );
  if (step === 'CONFIRMATION_RESPONSE') {
    const parsed = parseInteger(text, 0, 2_147_483_647, 'CONFIRMATION_RANGE');
    if (isParseError(parsed)) return parsed;
    if (
      snapshot.tentativePromptMinutesBefore !== undefined &&
      parsed > snapshot.tentativePromptMinutesBefore
    )
      return { error: 'CONFIRMATION_ORDER' };
    return { tentativeResponseMinutes: parsed };
  }
  if (step === 'REMINDER')
    return mapParsed(
      parseInteger(text, 0, 2_147_483_647, 'REMINDER_RANGE'),
      'reminderMinutesBefore',
    );
  if (step === 'COST') {
    if (text.trim() === '-') return { defaultTotalCostMinor: null };
    return mapParsed(parseRubles(text), 'defaultTotalCostMinor');
  }
  return null;
};

const mapParsed = <Key extends keyof GameTemplateSnapshot>(
  parsed: GameTemplateSnapshot[Key] | ParseError<string>,
  key: Key,
): Pick<GameTemplateSnapshot, Key> | ParseError<string> =>
  typeof parsed === 'object' && parsed !== null && 'error' in parsed
    ? parsed
    : ({ [key]: parsed } as Pick<GameTemplateSnapshot, Key>);

const isParseError = (value: unknown): value is ParseError<string> =>
  typeof value === 'object' && value !== null && 'error' in value;

const completeSnapshot = (
  snapshot: Partial<GameTemplateSnapshot>,
): GameTemplateSnapshot | null => {
  const complete = {
    ...snapshot,
    currency: 'RUB' as const,
  };
  const required = [
    'name',
    'venue',
    'address',
    'startsAtLocalTime',
    'durationMinutes',
    'capacity',
    'registrationOpensMinutesBefore',
    'registrationClosesMinutesBefore',
    'tentativePromptMinutesBefore',
    'tentativeResponseMinutes',
    'reminderMinutesBefore',
    'memberPriorityEnabled',
    'defaultTotalCostMinor',
    'roundingMode',
  ] as const;
  return required.every((key) => Object.hasOwn(complete, key))
    ? (complete as GameTemplateSnapshot)
    : null;
};

const snapshotOf = (template: GameTemplate): GameTemplateSnapshot => ({
  name: template.name,
  venue: template.venue,
  address: template.address,
  startsAtLocalTime: template.startsAtLocalTime,
  durationMinutes: template.durationMinutes,
  capacity: template.capacity,
  registrationOpensMinutesBefore: template.registrationOpensMinutesBefore,
  registrationClosesMinutesBefore: template.registrationClosesMinutesBefore,
  tentativePromptMinutesBefore: template.tentativePromptMinutesBefore,
  tentativeResponseMinutes: template.tentativeResponseMinutes,
  reminderMinutesBefore: template.reminderMinutesBefore,
  memberPriorityEnabled: template.memberPriorityEnabled,
  defaultTotalCostMinor: template.defaultTotalCostMinor,
  currency: template.currency,
  roundingMode: template.roundingMode,
});

const decodeTemplateId = (value: string | undefined): GameTemplateId | null => {
  if (value === undefined) return null;
  try {
    return asGameTemplateId(expandUuid(value));
  } catch {
    return null;
  }
};

const parseRevisionToken = (
  value: string | undefined,
): { templateId: GameTemplateId; revision: number } | null => {
  const [compactId, revisionText, ...rest] = value?.split('.') ?? [];
  const templateId = decodeTemplateId(compactId);
  const revision = Number.parseInt(revisionText ?? '', 36);
  return templateId === null ||
    rest.length > 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 1
    ? null
    : { templateId, revision };
};

const roundingByAction: Record<string, GameTemplateSnapshot['roundingMode']> = {
  'round-exact': 'EXACT',
  'round-1': 'UP_1',
  'round-10': 'UP_10',
  'round-50': 'UP_50',
};

const roundingFor = (
  action: string,
): GameTemplateSnapshot['roundingMode'] | null =>
  roundingByAction[action] ?? null;

const correctionText = (code: string): string =>
  ({
    NAME_LENGTH: 'Название должно содержать от 1 до 80 символов.',
    VENUE_LENGTH: 'Место должно содержать от 1 до 120 символов.',
    ADDRESS_LENGTH: 'Адрес должен содержать не более 300 символов.',
    TIME: 'Введите время в формате ЧЧ:ММ, например 19:30.',
    DURATION_RANGE: 'Введите длительность от 15 до 720 минут.',
    CAPACITY_RANGE: 'Введите количество мест от 1 до 200.',
    OPENING_RANGE: 'Введите целое неотрицательное количество минут.',
    CLOSING_RANGE: 'Введите целое неотрицательное количество минут или «-».',
    CLOSING_ORDER: 'Закрытие не может быть раньше открытия регистрации.',
    CONFIRMATION_RANGE: 'Введите целое неотрицательное количество минут.',
    CONFIRMATION_ORDER: 'Время на ответ не может превышать срок запроса.',
    REMINDER_RANGE: 'Введите целое неотрицательное количество минут.',
    COST_FORMAT: 'Введите сумму в рублях, например 1250,50, или «-».',
    COST_RANGE: 'Стоимость должна быть от 0 до 1 000 000 ₽.',
  })[code] ?? 'Проверьте введённое значение.';

const isExpectedTemplateError = (error: unknown): error is Error =>
  error instanceof Error &&
  [
    'TemplateRevisionConflictError',
    'TemplateNameConflictError',
    'TemplateInputError',
    'TemplateNotFoundError',
  ].includes(error.name);

const expectedErrorText = (error: Error): string =>
  error.name === 'TemplateNameConflictError'
    ? 'Активный шаблон с таким названием уже существует.'
    : error.name === 'TemplateNotFoundError'
      ? 'Шаблон больше не существует.'
      : 'Проверьте значения шаблона и исправьте ошибку.';

const replyView = async (
  context: Context,
  view: OrganizerView,
): Promise<void> => {
  await context.reply(view.text, viewOptions(view));
};

const editView = async (
  context: Context,
  view: OrganizerView,
): Promise<void> => {
  await context.editMessageText(view.text, viewOptions(view));
};

const viewOptions = (view: OrganizerView) => ({
  parse_mode: view.parseMode,
  reply_markup: {
    inline_keyboard: view.keyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    ),
  },
});
