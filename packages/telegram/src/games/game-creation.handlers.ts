import { randomUUID } from 'node:crypto';
import {
  OrganizerGroupSelectionRequiredError,
  TemplateInputError,
  validateTemplateSnapshot,
  type GameCreationDraft,
  type GameCreationDraftEditField,
  type GameCreationDraftExpectedView,
  type GameCreationDraftMutationResult,
  type OrganizerContext,
  type OrganizerGroupCandidate,
  type OrganizerTextFlowCoordinator,
  type PublishGameCommand,
} from '@volley/application';
import {
  asGameTemplateId,
  asGroupId,
  type Game,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import type { Bot, Context } from 'grammy';
import { toTelegramId } from '../group-onboarding.handlers.js';
import { renderGamePreview } from '../messages/game-preview.renderer.js';
import {
  LocalDateTimeResolutionError,
  localDateTimeToInstant,
} from '../organizer/local-date-time.js';
import type { OrganizerView } from '../organizer/main-menu.presenter.js';
import { safelyEditTelegramMessage } from '../organizer/safe-message-edit.js';
import type { SettingsEditorField } from '../organizer/settings-editor.model.js';
import {
  parseInteger,
  parseLocalDate,
  parseLocalTime,
  parseRubles,
  parseUnicodeText,
  type ParseError,
} from '../organizer/input.parsers.js';
import {
  expandGameCompactUuid,
  nextGameDraftView,
  parseGameDraftControlId,
  parseGameFieldCode,
  sameGameDraftControl,
  type GameDraftControl,
} from './game-creation.model.js';
import {
  isGameCreationCallbackShape,
  renderGameCancelConfirmation,
  renderGameCancelled,
  renderGameCustomize,
  renderGameDateStep,
  renderGameDraftResume,
  renderGameDraftSaved,
  renderGameFieldEditor,
  renderGameGroupPicker,
  renderGamePreviewView,
  renderGamePublished,
  renderGameTemplateChoice,
} from './game-creation.presenter.js';

export interface GameCreationDraftRepository {
  load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<GameCreationDraft | null>;
  replaceForNewFlow(
    draft: GameCreationDraft,
    expected?: GameCreationDraftExpectedView | null,
  ): Promise<GameCreationDraftMutationResult>;
  compareAndSet(
    draft: GameCreationDraft,
  ): Promise<GameCreationDraftMutationResult>;
  clear(
    groupId: GroupId,
    actorUserId: UserId,
    expected?: { draftId: string; viewRevision: number },
  ): Promise<boolean | void>;
}

export class GameCreationDraftStaleError extends Error {
  public constructor() {
    super('Game creation draft is stale');
    this.name = 'GameCreationDraftStaleError';
  }
}

interface GamePublisher {
  execute(command: PublishGameCommand): Promise<{
    game: Game;
    created: boolean;
  }>;
}

export interface GameCreationOrganizerContext {
  list(telegramUserId: TelegramId): Promise<readonly OrganizerGroupCandidate[]>;
  require(telegramUserId: TelegramId): Promise<OrganizerContext>;
  select(
    telegramUserId: TelegramId,
    groupId: GroupId,
  ): Promise<OrganizerContext>;
}

export interface GameCreationTemplates {
  list(input: {
    groupId: GroupId;
    archived: boolean;
    limit: number;
    afterId?: GameTemplateId | null;
  }): Promise<{
    items: readonly GameTemplate[];
    nextCursor: GameTemplateId | null;
  }>;
  findById(
    groupId: GroupId,
    templateId: GameTemplateId,
  ): Promise<GameTemplate | null>;
}

export interface GameCreationHandlerOptions {
  organizerContext: GameCreationOrganizerContext;
  drafts: GameCreationDraftRepository;
  templates: GameCreationTemplates;
  publishGame: GamePublisher;
  clock?: () => Date;
  textFlows?: OrganizerTextFlowCoordinator;
}

type ActorInput = {
  groupId: GroupId;
  actorUserId: UserId;
  timeZone?: string;
};

export class GameCreationHandlers {
  private readonly organizerContext?: GameCreationOrganizerContext;
  private readonly drafts: GameCreationDraftRepository;
  private readonly templates?: GameCreationTemplates;
  private readonly publishGame: GamePublisher;
  private readonly clock: () => Date;
  private readonly textFlows?: OrganizerTextFlowCoordinator;

  public constructor(options: GameCreationHandlerOptions);
  public constructor(
    drafts: GameCreationDraftRepository,
    publishGame: GamePublisher,
    clock?: () => Date,
  );
  public constructor(
    optionsOrDrafts: GameCreationHandlerOptions | GameCreationDraftRepository,
    legacyPublisher?: GamePublisher,
    legacyClock?: () => Date,
  ) {
    if ('organizerContext' in optionsOrDrafts) {
      this.organizerContext = optionsOrDrafts.organizerContext;
      this.drafts = optionsOrDrafts.drafts;
      this.templates = optionsOrDrafts.templates;
      this.publishGame = optionsOrDrafts.publishGame;
      this.clock = optionsOrDrafts.clock ?? (() => new Date());
      this.textFlows = optionsOrDrafts.textFlows;
      return;
    }
    this.drafts = optionsOrDrafts;
    this.publishGame = legacyPublisher!;
    this.clock = legacyClock ?? (() => new Date());
  }

  public async start(input: ActorInput): Promise<void>;
  public async start(input: TelegramId): Promise<OrganizerView>;
  public async start(
    input: ActorInput | TelegramId,
  ): Promise<void | OrganizerView> {
    if (typeof input !== 'string') return this.startDirect(input);
    const groups = await this.requiredOrganizer().list(input);
    if (groups.length !== 1) return renderGameGroupPicker(groups);
    const actor = await this.requiredOrganizer().select(
      input,
      groups[0]!.groupId,
    );
    const view = await this.openFor(actor);
    await this.claimCurrent(actor);
    return view;
  }

  public async startFromTemplate(
    telegramUserId: TelegramId,
    templateId: GameTemplateId,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const template = await this.requiredTemplates().findById(
      actor.groupId,
      templateId,
    );
    if (template === null || template.archivedAt !== null) {
      const view = await this.openFor(actor);
      return { ...view, text: `Шаблон больше недоступен.\n\n${view.text}` };
    }
    const current = await this.drafts.load(actor.groupId, actor.userId);
    await this.startDirect(
      actorInput(actor),
      current === null ? null : expectedView(current),
    );
    await this.selectTemplateDirect({
      ...actorInput(actor),
      templateId: template.id,
      snapshot: snapshotOf(template),
    });
    await this.claimCurrent(actor);
    return this.renderCurrent(
      actor,
      await this.requiredDraft(actorInput(actor)),
    );
  }

  public async continue(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (draft === null) return this.beginFor(actor);
    if (
      controlId !== undefined &&
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId))
    ) {
      return this.renderCurrent(actor, draft, staleControlText);
    }
    await this.claim(actor, draft);
    return this.renderCurrent(actor, draft);
  }

  public async restart(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      controlId !== undefined &&
      (draft === null ||
        !sameGameDraftControl(draft, parseGameDraftControlId(controlId)))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      await this.startDirect(
        actorInput(actor),
        draft === null ? null : expectedView(draft),
      );
      await this.claimCurrent(actor);
      return this.renderCurrent(
        actor,
        await this.requiredDraft(actorInput(actor)),
      );
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  public async selectTemplate(
    input: ActorInput & {
      templateId: GameTemplateId;
      snapshot: GameTemplateSnapshot;
    },
  ): Promise<void>;
  public async selectTemplate(
    telegramUserId: TelegramId,
    templateId: GameTemplateId,
    controlId: string,
  ): Promise<OrganizerView>;
  public async selectTemplate(
    input:
      | (ActorInput & {
          templateId: GameTemplateId;
          snapshot: GameTemplateSnapshot;
        })
      | TelegramId,
    templateId?: GameTemplateId,
    controlId?: string,
  ): Promise<void | OrganizerView> {
    if (typeof input !== 'string') return this.selectTemplateDirect(input);
    const actor = await this.requiredOrganizer().require(input);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId)) ||
      draft.step !== 'TEMPLATE'
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    const template = await this.requiredTemplates().findById(
      actor.groupId,
      templateId!,
    );
    if (template === null || template.archivedAt !== null) {
      return this.renderCurrent(
        actor,
        draft,
        'Шаблон больше недоступен. Выберите активный шаблон.',
      );
    }
    try {
      await this.selectTemplateDirect({
        ...actorInput(actor),
        templateId: template.id,
        snapshot: snapshotOf(template),
      });
      const updated = await this.requiredDraft(actorInput(actor));
      await this.claim(actor, updated);
      return this.renderCurrent(actor, updated);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  public async selectScratch(
    input: ActorInput & { settings: GameTemplateSnapshot },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.saveMutation(
      nextGameDraftView({
        ...draft,
        step: 'DATE',
        templateId: undefined,
        snapshot: { ...input.settings },
        editingField: undefined,
        cancelPending: false,
        previewed: false,
      }),
    );
  }

  public async setDate(
    telegramUserId: TelegramId,
    date: string,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.step !== 'DATE' ||
      (controlId !== undefined &&
        !sameGameDraftControl(draft, parseGameDraftControlId(controlId)))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    const parsedDate = parseLocalDate(date);
    if (isParseError(parsedDate)) {
      return renderGameDateStep(
        draft,
        actor.timeZone,
        'Введите дату в формате ДД.ММ.ГГГГ, например 10.09.2026.',
      );
    }
    try {
      const startsAt = localDateTimeToInstant({
        date: parsedDate,
        time: draft.snapshot!.startsAtLocalTime,
        timeZone: actor.timeZone,
      });
      await this.setStartsAtDirect({ ...actorInput(actor), startsAt });
      return this.renderCurrent(
        actor,
        await this.requiredDraft(actorInput(actor)),
      );
    } catch (error) {
      if (error instanceof LocalDateTimeResolutionError) {
        return renderGameDateStep(draft, actor.timeZone, localTimeErrorText);
      }
      return this.renderMutationError(actor, error);
    }
  }

  public async setStartsAt(
    input: ActorInput & { startsAt: Date },
  ): Promise<void> {
    return this.setStartsAtDirect(input);
  }

  public async editField(
    telegramUserId: TelegramId,
    field: SettingsEditorField,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.step !== 'CUSTOMIZE' ||
      draft.editingField !== undefined ||
      (controlId !== undefined &&
        !sameGameDraftControl(draft, parseGameDraftControlId(controlId)))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const updated = nextGameDraftView({
        ...draft,
        editingField: field as GameCreationDraftEditField,
        cancelPending: false,
        previewed: false,
      });
      await this.saveMutation(updated);
      await this.claim(actor, updated);
      return renderGameFieldEditor(updated, field);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  public async customize(
    input: ActorInput & { overrides: Partial<GameTemplateSnapshot> },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    if (draft.snapshot === undefined) {
      throw new Error('Game creation draft is incomplete');
    }
    await this.saveMutation(
      nextGameDraftView({
        ...draft,
        step: 'CUSTOMIZE',
        snapshot: { ...draft.snapshot, ...definedOverrides(input.overrides) },
        editingField: undefined,
        cancelPending: false,
        previewed: false,
      }),
    );
  }

  public async preview(input: ActorInput): Promise<string>;
  public async preview(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView>;
  public async preview(
    input: ActorInput | TelegramId,
    controlId?: string,
  ): Promise<string | OrganizerView> {
    if (typeof input !== 'string') {
      const previewed = await this.previewDraft(input);
      return renderGamePreview({
        source: previewed.templateId ?? 'scratch',
        startsAtIso: previewed.startsAtIso!,
        settings: previewed.snapshot,
        timeZone: input.timeZone,
        now: this.clock(),
      });
    }
    const actor = await this.requiredOrganizer().require(input);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.step !== 'CUSTOMIZE' ||
      draft.editingField !== undefined ||
      (controlId !== undefined &&
        !sameGameDraftControl(draft, parseGameDraftControlId(controlId)))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const previewed = await this.previewDraft(actorInput(actor));
      return renderGamePreviewView(previewed, actor.timeZone, this.clock());
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  public async publish(input: ActorInput): Promise<{
    game: Game;
    created: boolean;
  }>;
  public async publish(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView>;
  public async publish(
    input: ActorInput | TelegramId,
    controlId?: string,
  ): Promise<{ game: Game; created: boolean } | OrganizerView> {
    if (typeof input !== 'string') return this.publishDirect(input);
    const actor = await this.requiredOrganizer().require(input);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    const control = parseGameDraftControlId(controlId);
    if (
      draft === null ||
      !publishControlMatches(draft, control) ||
      (draft.step !== 'PREVIEW' && draft.step !== 'PUBLISHED')
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      await this.publishDirect(actorInput(actor), {
        draftId: control!.draftId,
        step: control!.step,
        viewRevision: control!.viewRevision,
      });
      await this.release(actor);
      const published = await this.requiredDraft(actorInput(actor));
      return renderGamePublished(published);
    } catch (error) {
      if (isExpectedPublicationError(error)) {
        const current = await this.drafts.load(actor.groupId, actor.userId);
        return current === null
          ? this.beginFor(actor, publicationErrorText(error))
          : this.renderCurrent(actor, current, publicationErrorText(error));
      }
      throw error;
    }
  }

  public async cancel(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.step === 'PUBLISHED' ||
      (controlId !== undefined &&
        !sameGameDraftControl(draft, parseGameDraftControlId(controlId)))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const updated = nextGameDraftView({ ...draft, cancelPending: true });
      await this.saveMutation(updated);
      return renderGameCancelConfirmation(updated);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  public async handleText(
    telegramUserId: TelegramId,
    text: string,
  ): Promise<OrganizerView | false> {
    if (text.startsWith('/')) return false;
    let actor: OrganizerContext;
    try {
      actor = await this.requiredOrganizer().require(telegramUserId);
    } catch (error) {
      if (isOrganizerSelectionError(error)) return false;
      throw error;
    }
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (draft === null || draft.cancelPending === true) return false;
    if (!(await this.owns(telegramUserId, actor, draft))) return false;
    if (draft.step === 'DATE') return this.setDate(telegramUserId, text);
    if (draft.step !== 'CUSTOMIZE' || draft.editingField === undefined)
      return false;
    const field = draft.editingField as SettingsEditorField;
    const parsed = parseFieldText(field, text, draft.snapshot!);
    if (parsed === null)
      return renderGameFieldEditor(
        draft,
        field,
        'Используйте кнопки под сообщением.',
      );
    if (isParseError(parsed))
      return renderGameFieldEditor(draft, field, correctionText(parsed.error));
    return this.applyFieldChange(
      actor,
      draft,
      parsed.changes,
      parsed.localTime,
    );
  }

  public async handleCallback(
    telegramUserId: TelegramId,
    data: string,
  ): Promise<OrganizerView> {
    const callback = parseCallback(data);
    if (callback === null)
      return this.currentForUser(telegramUserId, staleControlText);
    try {
      if (callback.action === 'g') {
        const groupId = decodeGroupId(callback.opaqueId);
        if (groupId === null)
          return renderGameGroupPicker(
            await this.requiredOrganizer().list(telegramUserId),
          );
        const actor = await this.requiredOrganizer().select(
          telegramUserId,
          groupId,
        );
        return this.openFor(actor);
      }
      if (callback.action === 'c')
        return this.continue(telegramUserId, callback.opaqueId);
      if (callback.action === 'r')
        return this.restart(telegramUserId, callback.opaqueId);
      if (callback.action === 't') {
        const token = parseEntityControl(callback.opaqueId);
        if (token === null)
          return this.currentForUser(telegramUserId, staleControlText);
        return this.selectTemplate(
          telegramUserId,
          asGameTemplateId(token.entityId),
          token.controlId,
        );
      }
      if (callback.action === 'e') {
        const token = parseFieldControl(callback.opaqueId);
        if (token === null)
          return this.currentForUser(telegramUserId, staleControlText);
        return this.editField(telegramUserId, token.field, token.controlId);
      }
      if (callback.action === 'p')
        return this.preview(telegramUserId, callback.opaqueId);
      if (callback.action === 'u')
        return this.publish(telegramUserId, callback.opaqueId);
      if (callback.action === 'x')
        return this.cancel(telegramUserId, callback.opaqueId);
      if (callback.action === 'b')
        return this.back(telegramUserId, callback.opaqueId);
      if (callback.action === 'y')
        return this.confirmCancel(telegramUserId, callback.opaqueId);
      if (callback.action === 'n')
        return this.resumeCancel(telegramUserId, callback.opaqueId);
      if (callback.action === 's')
        return this.selectFieldChoice(telegramUserId, callback.opaqueId);
      if (callback.action === 'k')
        return this.saveDraft(telegramUserId, callback.opaqueId);
      return this.currentForUser(telegramUserId, staleControlText);
    } catch (error) {
      if (isOrganizerSelectionError(error)) {
        return renderGameGroupPicker(
          await this.requiredOrganizer().list(telegramUserId),
        );
      }
      throw error;
    }
  }

  private async startDirect(
    input: ActorInput,
    expected?: GameCreationDraftExpectedView | null,
  ): Promise<void> {
    const currentExpected =
      expected === undefined
        ? expectedViewOrNull(
            await this.drafts.load(input.groupId, input.actorUserId),
          )
        : expected;
    const result = await this.drafts.replaceForNewFlow(
      {
        version: 1,
        draftId: randomUUID().replaceAll('-', ''),
        ...input,
        viewRevision: 0,
        step: 'TEMPLATE',
        cancelPending: false,
        previewed: false,
      },
      currentExpected,
    );
    if (result === 'STALE') throw new GameCreationDraftStaleError();
  }

  private async selectTemplateDirect(
    input: ActorInput & {
      templateId: GameTemplateId;
      snapshot: GameTemplateSnapshot;
    },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.saveMutation(
      nextGameDraftView({
        ...draft,
        step: 'DATE',
        templateId: input.templateId,
        snapshot: { ...input.snapshot },
        editingField: undefined,
        cancelPending: false,
        previewed: false,
      }),
    );
  }

  private async setStartsAtDirect(
    input: ActorInput & { startsAt: Date },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.saveMutation(
      nextGameDraftView({
        ...draft,
        step: 'CUSTOMIZE',
        startsAtIso: input.startsAt.toISOString(),
        editingField: undefined,
        cancelPending: false,
        previewed: false,
      }),
    );
  }

  private async previewDraft(input: ActorInput): Promise<GameCreationDraft> {
    const draft = await this.completeMutableDraft(input);
    const previewed = nextGameDraftView({
      ...draft,
      step: 'PREVIEW',
      editingField: undefined,
      cancelPending: false,
      previewed: true,
    });
    await this.saveMutation(previewed);
    return previewed;
  }

  private async publishDirect(
    input: ActorInput,
    expected?: GameCreationDraftExpectedView,
  ): Promise<{
    game: Game;
    created: boolean;
  }> {
    if (expected !== undefined) {
      return this.publishGame.execute({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        draftId: expected.draftId,
        expectedStep: expected.step,
        expectedViewRevision: expected.viewRevision,
        now: this.clock(),
      });
    }
    const draft = await this.completeDraft(input);
    if (!draft.previewed) {
      throw new Error('Game preview is required before publish');
    }
    return this.publishGame.execute({
      groupId: draft.groupId,
      actorUserId: draft.actorUserId,
      draftId: draft.draftId,
      expectedStep: draft.step === 'PUBLISHED' ? 'PREVIEW' : draft.step,
      expectedViewRevision: draft.viewRevision ?? 0,
      now: this.clock(),
    });
  }

  private async openFor(actor: OrganizerContext): Promise<OrganizerView> {
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (draft === null) return this.beginFor(actor);
    return draft.step === 'PUBLISHED'
      ? renderGamePublished(draft)
      : renderGameDraftResume(draft);
  }

  private async beginFor(
    actor: OrganizerContext,
    notice?: string,
  ): Promise<OrganizerView> {
    try {
      await this.startDirect(actorInput(actor), null);
    } catch (error) {
      if (!(error instanceof GameCreationDraftStaleError)) throw error;
    }
    await this.claimCurrent(actor);
    return this.renderCurrent(
      actor,
      await this.requiredDraft(actorInput(actor)),
      notice,
    );
  }

  private async renderCurrent(
    actor: OrganizerContext,
    draft: GameCreationDraft,
    notice?: string,
  ): Promise<OrganizerView> {
    if (draft.cancelPending === true)
      return renderGameCancelConfirmation(draft, notice);
    if (draft.step === 'TEMPLATE') {
      const page = await this.requiredTemplates().list({
        groupId: actor.groupId,
        archived: false,
        limit: 8,
      });
      return renderGameTemplateChoice({
        draft,
        templates: page.items,
        notice,
      });
    }
    if (draft.step === 'DATE')
      return renderGameDateStep(draft, actor.timeZone, notice);
    if (draft.step === 'CUSTOMIZE')
      return draft.editingField === undefined
        ? renderGameCustomize(draft, notice)
        : renderGameFieldEditor(
            draft,
            draft.editingField as SettingsEditorField,
            notice,
          );
    if (draft.step === 'PREVIEW')
      return renderGamePreviewView(draft, actor.timeZone, this.clock(), notice);
    return renderGamePublished(draft, notice);
  }

  private async currentForUser(
    telegramUserId: TelegramId,
    notice: string,
  ): Promise<OrganizerView> {
    try {
      const actor = await this.requiredOrganizer().require(telegramUserId);
      const draft = await this.drafts.load(actor.groupId, actor.userId);
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, notice);
    } catch (error) {
      if (!isOrganizerSelectionError(error)) throw error;
      return renderGameGroupPicker(
        await this.requiredOrganizer().list(telegramUserId),
      );
    }
  }

  private async back(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId)) ||
      draft.step === 'PUBLISHED'
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    let changed: GameCreationDraft;
    if (draft.step === 'DATE') {
      changed = {
        ...draft,
        step: 'TEMPLATE',
        templateId: undefined,
        snapshot: undefined,
        startsAtIso: undefined,
      };
    } else if (draft.step === 'CUSTOMIZE') {
      changed =
        draft.editingField === undefined
          ? { ...draft, step: 'DATE', startsAtIso: undefined }
          : { ...draft, editingField: undefined };
    } else if (draft.step === 'PREVIEW') {
      changed = { ...draft, step: 'CUSTOMIZE', previewed: false };
    } else {
      return this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const updated = nextGameDraftView({
        ...changed,
        cancelPending: false,
        previewed: false,
      });
      await this.saveMutation(updated);
      await this.claim(actor, updated);
      return this.renderCurrent(actor, updated);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  private async confirmCancel(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.cancelPending !== true ||
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId))
    ) {
      return draft === null
        ? renderGameCancelled()
        : this.renderCurrent(actor, draft, staleControlText);
    }
    const cleared = await this.drafts.clear(actor.groupId, actor.userId, {
      draftId: draft.draftId,
      viewRevision: draft.viewRevision ?? 0,
    });
    if (cleared === false) {
      const current = await this.drafts.load(actor.groupId, actor.userId);
      return current === null
        ? renderGameCancelled()
        : this.renderCurrent(actor, current, staleControlText);
    }
    await this.release(actor);
    return renderGameCancelled();
  }

  private async resumeCancel(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.cancelPending !== true ||
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const updated = nextGameDraftView({ ...draft, cancelPending: false });
      await this.saveMutation(updated);
      await this.claim(actor, updated);
      return this.renderCurrent(actor, updated);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  private async selectFieldChoice(
    telegramUserId: TelegramId,
    opaqueId?: string,
  ): Promise<OrganizerView> {
    const parsed = parseChoiceControl(opaqueId);
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      parsed === null ||
      draft === null ||
      draft.step !== 'CUSTOMIZE' ||
      !sameGameDraftControl(draft, parseGameDraftControlId(parsed.controlId))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    const changes = choiceChanges(draft.editingField, parsed.choice);
    return changes === null
      ? this.renderCurrent(actor, draft, staleControlText)
      : this.applyFieldChange(actor, draft, changes);
  }

  private async saveDraft(
    telegramUserId: TelegramId,
    controlId?: string,
  ): Promise<OrganizerView> {
    const actor = await this.requiredOrganizer().require(telegramUserId);
    const draft = await this.drafts.load(actor.groupId, actor.userId);
    if (
      draft === null ||
      draft.step !== 'PREVIEW' ||
      !sameGameDraftControl(draft, parseGameDraftControlId(controlId))
    ) {
      return draft === null
        ? this.beginFor(actor)
        : this.renderCurrent(actor, draft, staleControlText);
    }
    try {
      const updated = nextGameDraftView(draft);
      await this.saveMutation(updated);
      await this.release(actor);
      return renderGameDraftSaved(updated);
    } catch (error) {
      return this.renderMutationError(actor, error);
    }
  }

  private async applyFieldChange(
    actor: OrganizerContext,
    draft: GameCreationDraft,
    changes: Partial<GameTemplateSnapshot>,
    localTime?: string,
  ): Promise<OrganizerView> {
    try {
      let startsAtIso = draft.startsAtIso;
      if (localTime !== undefined) {
        startsAtIso = localDateTimeToInstant({
          date: localDateFor(draft.startsAtIso!, actor.timeZone),
          time: localTime,
          timeZone: actor.timeZone,
        }).toISOString();
      }
      const snapshot = validateTemplateSnapshot({
        ...draft.snapshot!,
        ...changes,
      });
      const updated = nextGameDraftView({
        ...draft,
        step: 'CUSTOMIZE',
        snapshot,
        startsAtIso,
        editingField: undefined,
        cancelPending: false,
        previewed: false,
      });
      await this.saveMutation(updated);
      return renderGameCustomize(updated);
    } catch (error) {
      if (error instanceof LocalDateTimeResolutionError) {
        return renderGameFieldEditor(
          draft,
          draft.editingField as SettingsEditorField,
          localTimeErrorText,
        );
      }
      if (error instanceof TemplateInputError) {
        return renderGameFieldEditor(
          draft,
          draft.editingField as SettingsEditorField,
          templateValidationErrorText(error),
        );
      }
      return this.renderMutationError(actor, error);
    }
  }

  private async renderMutationError(
    actor: OrganizerContext,
    error: unknown,
  ): Promise<OrganizerView> {
    if (!(error instanceof GameCreationDraftStaleError)) throw error;
    const current = await this.drafts.load(actor.groupId, actor.userId);
    return current === null
      ? this.beginFor(actor, staleControlText)
      : this.renderCurrent(actor, current, staleControlText);
  }

  private requiredOrganizer(): GameCreationOrganizerContext {
    if (this.organizerContext === undefined)
      throw new Error('Organizer context is required for the bot wizard');
    return this.organizerContext;
  }

  private requiredTemplates(): GameCreationTemplates {
    if (this.templates === undefined)
      throw new Error('Template service is required for the bot wizard');
    return this.templates;
  }

  private async requiredDraft(input: ActorInput): Promise<GameCreationDraft> {
    const draft = await this.drafts.load(input.groupId, input.actorUserId);
    if (draft === null) throw new Error('Game creation draft not found');
    return draft;
  }

  private async requiredMutableDraft(
    input: ActorInput,
  ): Promise<GameCreationDraft> {
    const draft = await this.requiredDraft(input);
    if (draft.step === 'PUBLISHED') {
      throw new Error('Published game creation draft is immutable');
    }
    return draft;
  }

  private async completeDraft(input: ActorInput): Promise<GameCreationDraft> {
    const draft = await this.requiredDraft(input);
    if (draft.startsAtIso === undefined || draft.snapshot === undefined) {
      throw new Error('Game creation draft is incomplete');
    }
    return draft;
  }

  private async completeMutableDraft(
    input: ActorInput,
  ): Promise<GameCreationDraft> {
    const draft = await this.requiredMutableDraft(input);
    if (draft.startsAtIso === undefined || draft.snapshot === undefined) {
      throw new Error('Game creation draft is incomplete');
    }
    return draft;
  }

  private async saveMutation(draft: GameCreationDraft): Promise<void> {
    if ((await this.drafts.compareAndSet(draft)) === 'STALE') {
      throw new GameCreationDraftStaleError();
    }
  }

  private async claimCurrent(actor: OrganizerContext): Promise<void> {
    await this.claim(actor, await this.requiredDraft(actorInput(actor)));
  }

  private async claim(
    actor: OrganizerContext,
    draft: GameCreationDraft,
  ): Promise<void> {
    await this.textFlows?.claim({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      kind: 'GAME_CREATION',
      reference: draft.draftId,
    });
  }

  private async release(actor: OrganizerContext): Promise<void> {
    await this.textFlows?.release({
      groupId: actor.groupId,
      actorUserId: actor.userId,
      kind: 'GAME_CREATION',
    });
  }

  private async owns(
    telegramUserId: TelegramId,
    actor: OrganizerContext,
    draft: GameCreationDraft,
  ): Promise<boolean> {
    if (this.textFlows === undefined) return true;
    const flow = await this.textFlows.current(telegramUserId);
    return (
      flow?.kind === 'GAME_CREATION' &&
      flow.groupId === actor.groupId &&
      flow.actorUserId === actor.userId &&
      flow.reference === draft.draftId
    );
  }
}

export const registerGameCreationHandlers = (
  bot: Bot<Context>,
  handlers: GameCreationHandlers,
): Bot<Context> => {
  bot.command('newgame', async (context) => {
    if (context.from === undefined || context.chat.type !== 'private') return;
    await replyView(
      context,
      await handlers.start(toTelegramId(context.from.id)),
    );
  });
  bot.callbackQuery(/^gc:v1:/, async (context) => {
    if (context.callbackQuery.message?.chat.type !== 'private') {
      await context.answerCallbackQuery();
      return;
    }
    try {
      await editView(
        context,
        await handlers.handleCallback(
          toTelegramId(context.callbackQuery.from.id),
          context.callbackQuery.data,
        ),
      );
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

const actorInput = (actor: OrganizerContext): ActorInput => ({
  groupId: actor.groupId,
  actorUserId: actor.userId,
  timeZone: actor.timeZone,
});

const expectedView = (
  draft: GameCreationDraft,
): GameCreationDraftExpectedView => ({
  draftId: draft.draftId,
  step: draft.step,
  viewRevision: draft.viewRevision ?? 0,
});

const expectedViewOrNull = (
  draft: GameCreationDraft | null,
): GameCreationDraftExpectedView | null =>
  draft === null ? null : expectedView(draft);

const parseCallback = (
  data: string,
): { action: string; opaqueId?: string } | null => {
  const [namespace, version, action, opaqueId, ...rest] = data.split(':');
  return namespace !== 'gc' ||
    version !== 'v1' ||
    action === undefined ||
    action.length === 0 ||
    !isGameCreationCallbackShape(action, opaqueId) ||
    rest.length > 0
    ? null
    : { action, ...(opaqueId === undefined ? {} : { opaqueId }) };
};

const parseEntityControl = (
  value: string | undefined,
): { entityId: string; controlId: string } | null => {
  const [compactEntityId, compactDraftId, step, revision, ...rest] =
    value?.split('.') ?? [];
  if (
    rest.length > 0 ||
    compactEntityId === undefined ||
    compactDraftId === undefined ||
    step === undefined ||
    revision === undefined
  ) {
    return null;
  }
  try {
    return {
      entityId: expandGameCompactUuid(compactEntityId),
      controlId: `${compactDraftId}.${step}.${revision}`,
    };
  } catch {
    return null;
  }
};

const parseFieldControl = (
  value: string | undefined,
): { field: SettingsEditorField; controlId: string } | null => {
  const [fieldCode, compactDraftId, step, revision, ...rest] =
    value?.split('.') ?? [];
  const field = parseGameFieldCode(fieldCode);
  return rest.length > 0 ||
    field === null ||
    compactDraftId === undefined ||
    step === undefined ||
    revision === undefined
    ? null
    : { field, controlId: `${compactDraftId}.${step}.${revision}` };
};

const parseChoiceControl = (
  value: string | undefined,
): { choice: string; controlId: string } | null => {
  const [choice, compactDraftId, step, revision, ...rest] =
    value?.split('.') ?? [];
  return rest.length > 0 ||
    choice === undefined ||
    compactDraftId === undefined ||
    step === undefined ||
    revision === undefined
    ? null
    : { choice, controlId: `${compactDraftId}.${step}.${revision}` };
};

const decodeGroupId = (value: string | undefined): GroupId | null => {
  if (value === undefined) return null;
  try {
    return asGroupId(expandGameCompactUuid(value));
  } catch {
    return null;
  }
};

const publishControlMatches = (
  draft: GameCreationDraft,
  control: GameDraftControl | null,
): boolean =>
  sameGameDraftControl(draft, control) ||
  (draft.step === 'PUBLISHED' &&
    control !== null &&
    control.draftId === draft.draftId &&
    control.step === 'PREVIEW' &&
    control.viewRevision === (draft.viewRevision ?? 0));

interface ParsedFieldValue {
  changes: Partial<GameTemplateSnapshot>;
  localTime?: string;
}

const parseFieldText = (
  field: SettingsEditorField,
  text: string,
  snapshot: GameTemplateSnapshot,
): ParsedFieldValue | ParseError<string> | null => {
  if (field === 'NAME')
    return parsedChange(parseUnicodeText(text, 1, 80, 'NAME_LENGTH'), 'name');
  if (field === 'VENUE')
    return parsedChange(
      parseUnicodeText(text, 1, 120, 'VENUE_LENGTH'),
      'venue',
    );
  if (field === 'ADDRESS') {
    if (text.trim() === '-') return { changes: { address: null } };
    return parsedChange(
      parseUnicodeText(text, 1, 300, 'ADDRESS_LENGTH'),
      'address',
    );
  }
  if (field === 'TIME') {
    const parsed = parseLocalTime(text);
    return isParseError(parsed)
      ? parsed
      : { changes: { startsAtLocalTime: parsed }, localTime: parsed };
  }
  if (field === 'DURATION')
    return parsedChange(
      parseInteger(text, 15, 720, 'DURATION_RANGE'),
      'durationMinutes',
    );
  if (field === 'CAPACITY')
    return parsedChange(
      parseInteger(text, 1, 200, 'CAPACITY_RANGE'),
      'capacity',
    );
  if (field === 'OPENING')
    return parsedChange(
      parseInteger(text, 0, 2_147_483_647, 'OPENING_RANGE'),
      'registrationOpensMinutesBefore',
    );
  if (field === 'CLOSING') {
    if (text.trim() === '-')
      return { changes: { registrationClosesMinutesBefore: null } };
    const parsed = parseInteger(text, 0, 2_147_483_647, 'CLOSING_RANGE');
    if (isParseError(parsed)) return parsed;
    return parsed > snapshot.registrationOpensMinutesBefore
      ? { error: 'CLOSING_ORDER' }
      : { changes: { registrationClosesMinutesBefore: parsed } };
  }
  if (field === 'CONFIRMATION_PROMPT')
    return parsedChange(
      parseInteger(text, 0, 2_147_483_647, 'CONFIRMATION_RANGE'),
      'tentativePromptMinutesBefore',
    );
  if (field === 'CONFIRMATION_RESPONSE') {
    const parsed = parseInteger(text, 0, 2_147_483_647, 'CONFIRMATION_RANGE');
    if (isParseError(parsed)) return parsed;
    return parsed > snapshot.tentativePromptMinutesBefore
      ? { error: 'CONFIRMATION_ORDER' }
      : { changes: { tentativeResponseMinutes: parsed } };
  }
  if (field === 'REMINDER')
    return parsedChange(
      parseInteger(text, 0, 2_147_483_647, 'REMINDER_RANGE'),
      'reminderMinutesBefore',
    );
  if (field === 'COST') {
    if (text.trim() === '-')
      return { changes: { defaultTotalCostMinor: null } };
    return parsedChange(parseRubles(text), 'defaultTotalCostMinor');
  }
  return null;
};

const parsedChange = <Key extends keyof GameTemplateSnapshot>(
  parsed: GameTemplateSnapshot[Key] | ParseError<string>,
  key: Key,
): ParsedFieldValue | ParseError<string> =>
  isParseError(parsed)
    ? parsed
    : { changes: { [key]: parsed } as Pick<GameTemplateSnapshot, Key> };

const choiceChanges = (
  field: GameCreationDraftEditField | undefined,
  choice: string,
): Partial<GameTemplateSnapshot> | null => {
  if (field === 'MEMBER_PRIORITY') {
    if (choice === 'y') return { memberPriorityEnabled: true };
    if (choice === 'n') return { memberPriorityEnabled: false };
  }
  if (field === 'ROUNDING') {
    const rounding = {
      e: 'EXACT',
      '1': 'UP_1',
      a: 'UP_10',
      f: 'UP_50',
    } as const;
    const value = rounding[choice as keyof typeof rounding];
    if (value !== undefined) return { roundingMode: value };
  }
  return null;
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

const localDateFor = (iso: string, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(iso))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const isParseError = (value: unknown): value is ParseError<string> =>
  typeof value === 'object' && value !== null && 'error' in value;

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

const staleControlText = 'Эта кнопка устарела. Продолжите с текущего шага.';
const localTimeErrorText =
  'Дата и время неоднозначны или не существуют в часовом поясе группы. Выберите другую дату.';

const isOrganizerSelectionError = (error: unknown): boolean =>
  error instanceof OrganizerGroupSelectionRequiredError ||
  (error instanceof Error &&
    error.name === 'OrganizerGroupSelectionRequiredError');

const isExpectedPublicationError = (error: unknown): error is Error =>
  error instanceof Error &&
  (error instanceof TemplateInputError ||
    error.name === 'TemplateInputError' ||
    error.name === 'AuthorizationDeniedError' ||
    /Game (?:start|registration closing time) must be in the future/i.test(
      error.message,
    ) ||
    /preview|required|incomplete|stale|draft not found/i.test(error.message));

const publicationErrorText = (error: Error): string =>
  error.name === 'AuthorizationDeniedError'
    ? 'У вас больше нет прав администратора этой группы.'
    : /registration closing time/i.test(error.message)
      ? 'Закрытие регистрации уже прошло. Измените дату или настройки игры.'
      : /start must be in the future/i.test(error.message)
        ? 'Дата и время игры должны быть в будущем.'
        : /stale|draft not found/i.test(error.message)
          ? staleControlText
          : 'Проверьте все поля и снова откройте предпросмотр.';

const templateValidationErrorText = (error: TemplateInputError): string =>
  error.code === 'CLOSING'
    ? correctionText('CLOSING_ORDER')
    : error.code === 'CONFIRMATION'
      ? correctionText('CONFIRMATION_ORDER')
      : correctionText(`${error.code}_RANGE`);

const definedOverrides = (
  overrides: Partial<GameTemplateSnapshot>,
): Partial<GameTemplateSnapshot> =>
  Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<GameTemplateSnapshot>;

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
  await safelyEditTelegramMessage(() =>
    context.editMessageText(view.text, viewOptions(view)),
  );
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
