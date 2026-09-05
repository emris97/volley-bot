import {
  asGameTemplateId,
  asGroupId,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
} from '@volley/domain';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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
  revision: row.revision,
  archivedAt: row.archivedAt,
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
        and(
          eq(gameTemplates.groupId, groupId),
          eq(gameTemplates.id, templateId),
        ),
      )
      .limit(1);
    return row === undefined ? null : toTemplate(row);
  }

  public async insert(
    input: GameTemplateSnapshot & { groupId: GroupId },
  ): Promise<GameTemplate> {
    const row = await this.withNameConflict(() =>
      this.database
        .insert(gameTemplates)
        .values(input)
        .returning()
        .then(([inserted]) => inserted),
    );
    if (row === undefined) throw new Error('Template insert returned no row');
    return toTemplate(row);
  }

  public async list(
    groupId: GroupId,
    options: {
      archived: boolean;
      limit: number;
      afterId?: GameTemplateId | null;
    },
  ): Promise<{
    items: readonly GameTemplate[];
    nextCursor: GameTemplateId | null;
  }> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new Error('Template list limit must be a positive safe integer');
    }
    const normalizedName = sql`lower(btrim(${gameTemplates.name}))`;
    const after =
      options.afterId == null
        ? undefined
        : sql`(
            ${normalizedName} > (
              SELECT lower(btrim(name))
              FROM game_templates
              WHERE id = ${options.afterId} AND group_id = ${groupId}
            )
            OR (
              ${normalizedName} = (
                SELECT lower(btrim(name))
                FROM game_templates
                WHERE id = ${options.afterId} AND group_id = ${groupId}
              )
              AND ${gameTemplates.id} > ${options.afterId}
            )
          )`;
    const rows = await this.database
      .select()
      .from(gameTemplates)
      .where(
        and(
          eq(gameTemplates.groupId, groupId),
          options.archived
            ? isNotNull(gameTemplates.archivedAt)
            : isNull(gameTemplates.archivedAt),
          ...(after === undefined ? [] : [after]),
        ),
      )
      .orderBy(asc(normalizedName), asc(gameTemplates.id))
      .limit(options.limit + 1);
    const hasNextPage = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map(toTemplate);
    return {
      items,
      nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
    };
  }

  public async update(input: {
    groupId: GroupId;
    templateId: GameTemplateId;
    expectedRevision: number;
    snapshot: GameTemplateSnapshot;
  }): Promise<GameTemplate | null> {
    const row = await this.withNameConflict(() =>
      this.database
        .update(gameTemplates)
        .set({
          ...snapshotValues(input.snapshot),
          revision: sql`${gameTemplates.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(gameTemplates.groupId, input.groupId),
            eq(gameTemplates.id, input.templateId),
            eq(gameTemplates.revision, input.expectedRevision),
          ),
        )
        .returning()
        .then(([updated]) => updated),
    );
    return row === undefined ? null : toTemplate(row);
  }

  public async setArchived(input: {
    groupId: GroupId;
    templateId: GameTemplateId;
    expectedRevision: number;
    archived: boolean;
  }): Promise<GameTemplate | null> {
    const row = await this.withNameConflict(() =>
      this.database
        .update(gameTemplates)
        .set({
          archivedAt: input.archived ? new Date() : null,
          revision: sql`${gameTemplates.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(gameTemplates.groupId, input.groupId),
            eq(gameTemplates.id, input.templateId),
            eq(gameTemplates.revision, input.expectedRevision),
          ),
        )
        .returning()
        .then(([updated]) => updated),
    );
    return row === undefined ? null : toTemplate(row);
  }

  private async withNameConflict<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isActiveNameConflict(error)) {
        throw templateNameConflictError();
      }
      throw error;
    }
  }
}

const snapshotValues = (snapshot: GameTemplateSnapshot) => ({
  name: snapshot.name,
  venue: snapshot.venue,
  address: snapshot.address,
  startsAtLocalTime: snapshot.startsAtLocalTime,
  durationMinutes: snapshot.durationMinutes,
  capacity: snapshot.capacity,
  registrationOpensMinutesBefore: snapshot.registrationOpensMinutesBefore,
  registrationClosesMinutesBefore: snapshot.registrationClosesMinutesBefore,
  tentativePromptMinutesBefore: snapshot.tentativePromptMinutesBefore,
  tentativeResponseMinutes: snapshot.tentativeResponseMinutes,
  reminderMinutesBefore: snapshot.reminderMinutesBefore,
  memberPriorityEnabled: snapshot.memberPriorityEnabled,
  defaultTotalCostMinor: snapshot.defaultTotalCostMinor,
  currency: snapshot.currency,
  roundingMode: snapshot.roundingMode,
});

const templateNameConflictError = (): Error => {
  const error = new Error('An active template with this name already exists');
  error.name = 'TemplateNameConflictError';
  return error;
};

const isActiveNameConflict = (error: unknown): boolean => {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === 'object' && current !== null) {
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      candidate.code === '23505' &&
      candidate.constraint === 'game_templates_active_name_unique'
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
};
