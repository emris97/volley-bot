import type { GameTemplateId, GroupId } from '@volley/domain';
import type { TemplatePage, TemplateRepository } from './ports.js';

export interface ListTemplatesCommand {
  groupId: GroupId;
  archived?: boolean;
  limit: number;
  afterId?: GameTemplateId | null;
}

export class ListTemplates {
  public constructor(private readonly templates: TemplateRepository) {}

  public execute(command: ListTemplatesCommand): Promise<TemplatePage> {
    return this.templates.list(command.groupId, {
      archived: command.archived ?? false,
      limit: command.limit,
      afterId: command.afterId,
    });
  }
}
