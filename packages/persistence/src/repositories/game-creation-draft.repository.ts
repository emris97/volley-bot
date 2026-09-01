import {
  asGameTemplateId,
  asGroupId,
  asUserId,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { gameCreationDrafts } from '../schema/index.js';

export interface StoredGameCreationDraft {
  groupId: GroupId;
  actorUserId: UserId;
  templateId?: GameTemplateId;
  scratchSettings?: GameTemplateSnapshot;
  startsAtIso?: string;
  previewed: boolean;
}

export class GameCreationDraftRepository {
  public constructor(private readonly database: Database) {}

  public async load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<StoredGameCreationDraft | null> {
    const [row] = await this.database
      .select()
      .from(gameCreationDrafts)
      .where(
        and(
          eq(gameCreationDrafts.groupId, groupId),
          eq(gameCreationDrafts.actorUserId, actorUserId),
        ),
      )
      .limit(1);
    if (row === undefined) return null;
    const data = revive(row.data);
    return {
      groupId: asGroupId(row.groupId),
      actorUserId: asUserId(row.actorUserId),
      ...(typeof data.templateId === 'string'
        ? { templateId: asGameTemplateId(data.templateId) }
        : {}),
      ...(data.scratchSettings === undefined
        ? {}
        : { scratchSettings: data.scratchSettings as GameTemplateSnapshot }),
      ...(typeof data.startsAtIso === 'string'
        ? { startsAtIso: data.startsAtIso }
        : {}),
      previewed: data.previewed === true,
    };
  }

  public async save(draft: StoredGameCreationDraft): Promise<void> {
    const data = serialize({
      templateId: draft.templateId,
      scratchSettings: draft.scratchSettings,
      startsAtIso: draft.startsAtIso,
      previewed: draft.previewed,
    });
    await this.database
      .insert(gameCreationDrafts)
      .values({
        groupId: draft.groupId,
        actorUserId: draft.actorUserId,
        data,
      })
      .onConflictDoUpdate({
        target: [gameCreationDrafts.groupId, gameCreationDrafts.actorUserId],
        set: { data, updatedAt: new Date() },
      });
  }

  public async clear(groupId: GroupId, actorUserId: UserId): Promise<void> {
    await this.database
      .delete(gameCreationDrafts)
      .where(
        and(
          eq(gameCreationDrafts.groupId, groupId),
          eq(gameCreationDrafts.actorUserId, actorUserId),
        ),
      );
  }
}

const serialize = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? `bigint:${item}` : item,
    ),
  ) as Record<string, unknown>;

const revive = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item === 'string' && /^bigint:\d+$/.test(item)) {
      return BigInt(item.slice(7));
    }
    return item;
  }) as Record<string, unknown>;
