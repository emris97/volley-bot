import type {
  GameTemplate,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';
import type { GameAuthorization, TemplateRepository } from './ports.js';

export interface CreateTemplateCommand extends GameTemplateSnapshot {
  groupId: GroupId;
  actorUserId: UserId;
}

export class CreateTemplate {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly templates: TemplateRepository,
  ) {}

  public async execute(command: CreateTemplateCommand): Promise<GameTemplate> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const { actorUserId: _actorUserId, ...template } = command;
    void _actorUserId;
    return this.templates.insert(template);
  }
}
