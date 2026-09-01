import type { CreateGameCommand } from '@volley/application';
import type {
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';
import { renderGamePreview } from '../messages/game-preview.renderer.js';

export interface GameCreationDraft {
  groupId: GroupId;
  actorUserId: UserId;
  templateId?: GameTemplateId;
  scratchSettings?: GameTemplateSnapshot;
  startsAtIso?: string;
  previewed: boolean;
}

export interface GameCreationDraftRepository {
  load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<GameCreationDraft | null>;
  save(draft: GameCreationDraft): Promise<void>;
  clear(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

interface GameCreator {
  execute(command: CreateGameCommand): Promise<unknown>;
}

type ActorInput = { groupId: GroupId; actorUserId: UserId };

export class GameCreationHandlers {
  public constructor(
    private readonly drafts: GameCreationDraftRepository,
    private readonly createGame: GameCreator,
  ) {}

  public async start(input: ActorInput): Promise<void> {
    const existing = await this.drafts.load(input.groupId, input.actorUserId);
    if (existing === null) {
      await this.drafts.save({ ...input, previewed: false });
    }
  }

  public async selectTemplate(
    input: ActorInput & { templateId: GameTemplateId },
  ): Promise<void> {
    const draft = await this.requiredDraft(input);
    await this.drafts.save({
      ...draft,
      templateId: input.templateId,
      scratchSettings: undefined,
      previewed: false,
    });
  }

  public async selectScratch(
    input: ActorInput & { settings: GameTemplateSnapshot },
  ): Promise<void> {
    const draft = await this.requiredDraft(input);
    await this.drafts.save({
      ...draft,
      templateId: undefined,
      scratchSettings: { ...input.settings },
      previewed: false,
    });
  }

  public async setStartsAt(
    input: ActorInput & { startsAt: Date },
  ): Promise<void> {
    const draft = await this.requiredDraft(input);
    await this.drafts.save({
      ...draft,
      startsAtIso: input.startsAt.toISOString(),
      previewed: false,
    });
  }

  public async preview(input: ActorInput): Promise<string> {
    const draft = await this.completeDraft(input);
    await this.drafts.save({ ...draft, previewed: true });
    return renderGamePreview({
      source: draft.templateId ?? 'scratch',
      startsAtIso: draft.startsAtIso!,
      settings: draft.scratchSettings,
    });
  }

  public async publish(input: ActorInput): Promise<void> {
    const draft = await this.completeDraft(input);
    if (!draft.previewed)
      throw new Error('Game preview is required before publish');
    await this.createGame.execute({
      groupId: draft.groupId,
      actorUserId: draft.actorUserId,
      ...(draft.templateId === undefined
        ? {}
        : { templateId: draft.templateId }),
      startsAt: new Date(draft.startsAtIso!),
      overrides: draft.scratchSettings ?? {},
    });
    await this.drafts.clear(draft.groupId, draft.actorUserId);
  }

  private async requiredDraft(input: ActorInput): Promise<GameCreationDraft> {
    const draft = await this.drafts.load(input.groupId, input.actorUserId);
    if (draft === null) throw new Error('Game creation draft not found');
    return draft;
  }

  private async completeDraft(input: ActorInput): Promise<GameCreationDraft> {
    const draft = await this.requiredDraft(input);
    if (
      draft.startsAtIso === undefined ||
      (draft.templateId === undefined && draft.scratchSettings === undefined)
    ) {
      throw new Error('Game creation draft is incomplete');
    }
    return draft;
  }
}
