import type {
  GameTemplate,
  GameTemplateId,
  GroupId,
  UserId,
} from '@volley/domain';
import type { GameAuthorization, TemplateRepository } from './ports.js';
import {
  TemplateNotFoundError,
  TemplateRevisionConflictError,
} from './template-errors.js';

export interface SetTemplateArchivedCommand {
  groupId: GroupId;
  actorUserId: UserId;
  templateId: GameTemplateId;
  expectedRevision: number;
  archived: boolean;
}

export class SetTemplateArchived {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly templates: TemplateRepository,
  ) {}

  public async execute(
    command: SetTemplateArchivedCommand,
  ): Promise<GameTemplate> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const existing = await this.templates.findById(
      command.groupId,
      command.templateId,
    );
    if (existing === null) throw new TemplateNotFoundError();
    const updated = await this.templates.setArchived(command);
    if (updated === null) throw new TemplateRevisionConflictError();
    return updated;
  }
}
