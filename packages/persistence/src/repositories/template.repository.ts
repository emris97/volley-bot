import {
  asGameTemplateId,
  asGroupId,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { gameTemplates } from '../schema/index.js';

const toTemplate = (row: typeof gameTemplates.$inferSelect): GameTemplate => ({
  id: asGameTemplateId(row.id),
  groupId: asGroupId(row.groupId),
  name: row.name,
  venue: row.venue,
  address: row.address,
  startsAtLocalTime: row.startsAtLocalTime,
  durationMinutes: row.durationMinutes,
  capacity: row.capacity,
  registrationOpensMinutesBefore: row.registrationOpensMinutesBefore,
  registrationClosesMinutesBefore: row.registrationClosesMinutesBefore,
  tentativePromptMinutesBefore: row.tentativePromptMinutesBefore,
  tentativeResponseMinutes: row.tentativeResponseMinutes,
  reminderMinutesBefore: row.reminderMinutesBefore,
  memberPriorityEnabled: row.memberPriorityEnabled,
  defaultTotalCostMinor: row.defaultTotalCostMinor,
  currency: 'RUB',
  roundingMode: row.roundingMode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export class TemplateRepository {
  public constructor(private readonly database: Database) {}

  public async findById(
    groupId: GroupId,
    templateId: GameTemplateId,
  ): Promise<GameTemplate | null> {
    const [row] = await this.database
      .select()
      .from(gameTemplates)
      .where(
        and(eq(gameTemplates.groupId, groupId), eq(gameTemplates.id, templateId)),
      )
      .limit(1);
    return row === undefined ? null : toTemplate(row);
  }

  public async insert(
    input: GameTemplateSnapshot & { groupId: GroupId },
  ): Promise<GameTemplate> {
    const [row] = await this.database
      .insert(gameTemplates)
      .values(input)
      .returning();
    if (row === undefined) throw new Error('Template insert returned no row');
    return toTemplate(row);
  }
}
