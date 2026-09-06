import {
  createGameFromTemplate,
  type Game,
  type GroupId,
  type UserId,
} from '@volley/domain';
import type { GameCreationDraft } from './game-creation-draft.js';
import type {
  GameAuthorization,
  GameGroupSettingsRepository,
  GamePublicationRepository,
} from './ports.js';
import { validateTemplateSnapshot } from './template-validation.js';

export interface PublishGameCommand {
  groupId: GroupId;
  actorUserId: UserId;
  draftId: string;
  now: Date;
}

export class PublishGame {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly groups: GameGroupSettingsRepository,
    private readonly publications: GamePublicationRepository,
  ) {}

  public async execute(command: PublishGameCommand): Promise<{
    game: Game;
    created: boolean;
  }> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const timeZone = await this.groups.findTimeZone(command.groupId);
    if (timeZone === null) throw new Error('Group not found');

    return this.publications.publishDraft(command, (draft) =>
      buildGame(draft, command, timeZone),
    );
  }
}

const buildGame = (
  draft: GameCreationDraft,
  command: PublishGameCommand,
  timeZone: string,
): Game => {
  if (
    draft.groupId !== command.groupId ||
    draft.actorUserId !== command.actorUserId ||
    draft.draftId !== command.draftId
  ) {
    throw new Error('Game creation draft is stale');
  }
  if (!draft.previewed || draft.step !== 'PREVIEW') {
    throw new Error('Game preview is required before publish');
  }
  if (draft.snapshot === undefined || draft.startsAtIso === undefined) {
    throw new Error('Game creation draft is incomplete');
  }
  const startsAt = new Date(draft.startsAtIso);
  if (!Number.isFinite(startsAt.getTime())) {
    throw new Error('Game creation draft has an invalid start');
  }
  if (startsAt.getTime() <= command.now.getTime()) {
    throw new Error('Game start must be in the future');
  }

  const snapshot = validateTemplateSnapshot(draft.snapshot);
  const game: Game = {
    ...createGameFromTemplate(snapshot, startsAt, timeZone),
    groupId: command.groupId,
    sourceTemplateId: draft.templateId ?? null,
  };
  if (
    game.registrationClosesAt !== null &&
    game.registrationClosesAt.getTime() <= command.now.getTime()
  ) {
    throw new Error('Game registration closing time must be in the future');
  }
  return {
    ...game,
    state:
      game.registrationOpensAt.getTime() <= command.now.getTime()
        ? 'OPEN'
        : 'SCHEDULED',
    revision: 0,
  };
};
