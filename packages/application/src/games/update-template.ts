import type {
  GameTemplate,
  GameTemplateId,
  GameTemplateSnapshot,
  GroupId,
  UserId,
} from '@volley/domain';
import type { GameAuthorization, TemplateRepository } from './ports.js';
import {
  TemplateNotFoundError,
  TemplateRevisionConflictError,
} from './template-errors.js';
import { validateTemplateSnapshot } from './template-validation.js';

export interface UpdateTemplateCommand {
  groupId: GroupId;
  actorUserId: UserId;
  templateId: GameTemplateId;
  expectedRevision: number;
  snapshot: GameTemplateSnapshot;
}

export class UpdateTemplate {
  public constructor(
    private readonly authorization: GameAuthorization,
    private readonly templates: TemplateRepository,
  ) {}

  public async execute(command: UpdateTemplateCommand): Promise<GameTemplate> {
    await this.authorization.requireOrganizer(
      command.groupId,
      command.actorUserId,
    );
    const snapshot = validateTemplateSnapshot(command.snapshot);
    const existing = await this.templates.findById(
      command.groupId,
      command.templateId,
    );
    if (existing === null) throw new TemplateNotFoundError();
    const updated = await this.templates.update({ ...command, snapshot });
    if (updated === null) throw new TemplateRevisionConflictError();
    return updated;
  }
}
