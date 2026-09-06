import { randomUUID } from 'node:crypto';
import type {
  GameCreationDraft,
  PublishGameCommand,
} from '@volley/application';
import type {
  Game,
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';
import { renderGamePreview } from '../messages/game-preview.renderer.js';

export interface GameCreationDraftRepository {
  load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<GameCreationDraft | null>;
  save(draft: GameCreationDraft): Promise<void>;
  clear(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

interface GamePublisher {
  execute(command: PublishGameCommand): Promise<{
    game: Game;
    created: boolean;
  }>;
}

type ActorInput = { groupId: GroupId; actorUserId: UserId };

export class GameCreationHandlers {
  public constructor(
    private readonly drafts: GameCreationDraftRepository,
    private readonly publishGame: GamePublisher,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async start(input: ActorInput): Promise<void> {
    await this.drafts.save({
      version: 1,
      draftId: randomUUID().replaceAll('-', ''),
      ...input,
      step: 'TEMPLATE',
      previewed: false,
    });
  }

  public async selectTemplate(
    input: ActorInput & {
      templateId: GameTemplateId;
      snapshot: GameTemplateSnapshot;
    },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.drafts.save({
      ...draft,
      step: 'DATE',
      templateId: input.templateId,
      snapshot: { ...input.snapshot },
      previewed: false,
    });
  }

  public async selectScratch(
    input: ActorInput & { settings: GameTemplateSnapshot },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.drafts.save({
      ...draft,
      step: 'DATE',
      templateId: undefined,
      snapshot: { ...input.settings },
      previewed: false,
    });
  }

  public async setStartsAt(
    input: ActorInput & { startsAt: Date },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    await this.drafts.save({
      ...draft,
      step: 'CUSTOMIZE',
      startsAtIso: input.startsAt.toISOString(),
      previewed: false,
    });
  }

  public async customize(
    input: ActorInput & { overrides: Partial<GameTemplateSnapshot> },
  ): Promise<void> {
    const draft = await this.requiredMutableDraft(input);
    if (draft.snapshot === undefined) {
      throw new Error('Game creation draft is incomplete');
    }
    await this.drafts.save({
      ...draft,
      step: 'CUSTOMIZE',
      snapshot: { ...draft.snapshot, ...definedOverrides(input.overrides) },
      previewed: false,
    });
  }

  public async preview(input: ActorInput): Promise<string> {
    const draft = await this.completeMutableDraft(input);
    const previewed: GameCreationDraft = {
      ...draft,
      step: 'PREVIEW',
      previewed: true,
    };
    await this.drafts.save(previewed);
    return renderGamePreview({
      source: previewed.templateId ?? 'scratch',
      startsAtIso: previewed.startsAtIso!,
      settings: previewed.snapshot,
    });
  }

  public async publish(input: ActorInput): Promise<{
    game: Game;
    created: boolean;
  }> {
    const draft = await this.completeDraft(input);
    if (!draft.previewed) {
      throw new Error('Game preview is required before publish');
    }
    return this.publishGame.execute({
      groupId: draft.groupId,
      actorUserId: draft.actorUserId,
      draftId: draft.draftId,
      now: this.clock(),
    });
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
}

const definedOverrides = (
  overrides: Partial<GameTemplateSnapshot>,
): Partial<GameTemplateSnapshot> =>
  Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<GameTemplateSnapshot>;
