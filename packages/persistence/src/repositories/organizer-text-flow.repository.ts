import type {
  OrganizerTextFlow,
  OrganizerTextFlowCoordinator,
} from '@volley/application';
import { asGroupId, asUserId, type TelegramId } from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { organizerTextFlows, users } from '../schema/index.js';

export class OrganizerTextFlowRepository implements OrganizerTextFlowCoordinator {
  public constructor(private readonly database: Database) {}

  public async claim(
    input: Parameters<OrganizerTextFlowCoordinator['claim']>[0],
  ): Promise<OrganizerTextFlow> {
    const updatedAt = new Date();
    const [row] = await this.database
      .insert(organizerTextFlows)
      .values({
        actorUserId: input.actorUserId,
        groupId: input.groupId,
        kind: input.kind,
        reference: input.reference ?? null,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: organizerTextFlows.actorUserId,
        set: {
          groupId: input.groupId,
          kind: input.kind,
          reference: input.reference ?? null,
          updatedAt,
        },
      })
      .returning();
    if (row === undefined)
      throw new Error('Failed to claim organizer text flow');
    return mapRow(row);
  }

  public async current(
    telegramUserId: TelegramId,
  ): Promise<OrganizerTextFlow | null> {
    const [row] = await this.database
      .select({ flow: organizerTextFlows })
      .from(organizerTextFlows)
      .innerJoin(users, eq(users.id, organizerTextFlows.actorUserId))
      .where(eq(users.telegramUserId, BigInt(telegramUserId)))
      .limit(1);
    return row === undefined ? null : mapRow(row.flow);
  }

  public async release(
    input: Parameters<OrganizerTextFlowCoordinator['release']>[0],
  ): Promise<boolean> {
    const rows = await this.database
      .delete(organizerTextFlows)
      .where(
        and(
          eq(organizerTextFlows.groupId, input.groupId),
          eq(organizerTextFlows.actorUserId, input.actorUserId),
          eq(organizerTextFlows.kind, input.kind),
        ),
      )
      .returning({ actorUserId: organizerTextFlows.actorUserId });
    return rows.length === 1;
  }
}

const mapRow = (
  row: typeof organizerTextFlows.$inferSelect,
): OrganizerTextFlow => ({
  groupId: asGroupId(row.groupId),
  actorUserId: asUserId(row.actorUserId),
  kind: row.kind,
  reference: row.reference,
  updatedAt: row.updatedAt,
});
