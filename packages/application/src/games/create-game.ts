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
    const timeZone = await this.groups.findTimeZone(command.groupId);
    if (timeZone === null) throw new Error('Group not found');
    let snapshot: GameTemplateSnapshot;
    if (command.templateId === undefined) {
      snapshot = completeScratchSnapshot(command.overrides);
    } else {
      const template = await this.templates.findById(
        command.groupId,
        command.templateId,
      );
      if (template === null) throw new Error('Template not found');
      snapshot = { ...template, ...definedOverrides(command.overrides) };
    }
    const game: Game = {
      ...createGameFromTemplate(snapshot, command.startsAt, timeZone),
      groupId: command.groupId,
      sourceTemplateId: command.templateId ?? null,
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

const completeScratchSnapshot = (
  overrides: Partial<GameTemplateSnapshot>,
): GameTemplateSnapshot => {
  const requiredKeys: Array<keyof GameTemplateSnapshot> = [
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
    'currency',
    'roundingMode',
  ];
  const missing = requiredKeys.filter((key) => overrides[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Scratch game settings are incomplete: ${missing.join(', ')}`,
    );
  }
  return overrides as GameTemplateSnapshot;
};
