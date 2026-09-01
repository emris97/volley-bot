import {
  createGameFromTemplate,
  type Game,
  type GameTemplateSnapshot,
  type GameTemplateId,
  type GroupId,
  type UserId,
} from '@volley/domain';
import type {
  GameAuthorization,
  GameGroupSettingsRepository,
  GameRepository,
  TemplateRepository,
} from './ports.js';

export interface CreateGameCommand {
  groupId: GroupId;
  actorUserId: UserId;
  templateId?: GameTemplateId;
  startsAt: Date;
  overrides: Partial<GameTemplateSnapshot>;
}

export class CreateGame {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly templates: TemplateRepository,
    private readonly games: GameRepository,
    private readonly groups: GameGroupSettingsRepository,
  ) {}

  public async execute(command: CreateGameCommand): Promise<Game> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    if (command.templateId === undefined) {
      throw new Error('Template is required until scratch defaults are provided');
    }
    const template = await this.templates.findById(
      command.groupId,
      command.templateId,
    );
    if (template === null) throw new Error('Template not found');

    const timeZone = await this.groups.findTimeZone(command.groupId);
    if (timeZone === null) throw new Error('Group not found');

    const snapshot: GameTemplateSnapshot = {
      ...template,
      ...definedOverrides(command.overrides),
    };
    const game: Game = {
      ...createGameFromTemplate(snapshot, command.startsAt, timeZone),
      groupId: command.groupId,
      sourceTemplateId: command.templateId,
    };
    return this.games.insert(game, command.actorUserId);
  }
}

const definedOverrides = (
  overrides: Partial<GameTemplateSnapshot>,
): Partial<GameTemplateSnapshot> =>
  Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<GameTemplateSnapshot>;
