import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  type Game,
  type GameId,
  type GameState,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  auditEvents,
  games,
  outboxEvents,
  scheduledJobs,
} from '../schema/index.js';

const toGame = (row: typeof games.$inferSelect): Game => ({
  id: asGameId(row.id),
  groupId: asGroupId(row.groupId),
  sourceTemplateId:
    row.sourceTemplateId === null
      ? null
      : asGameTemplateId(row.sourceTemplateId),
  name: row.name,
  venue: row.venue,
  address: row.address,
  startsAt: row.startsAt,
  durationMinutes: row.durationMinutes,
  capacity: row.capacity,
  timeZone: row.timeZone,
  registrationOpensAt: row.registrationOpensAt,
  registrationClosesAt: row.registrationClosesAt,
  tentativePromptAt: row.tentativePromptAt,
  tentativeResponseDeadline: row.tentativeResponseDeadline,
  reminderAt: row.reminderAt,
  memberPriorityEnabled: row.memberPriorityEnabled,
  totalCostMinor: row.totalCostMinor,
  currency: 'RUB',
  roundingMode: row.roundingMode,
  state: row.state,
  scheduleRevision: row.scheduleRevision,
  canonicalTelegramMessageId: row.canonicalTelegramMessageId,
});

const insertValues = (game: Game) => ({
  groupId: required(game.groupId, 'Game group is required'),
  sourceTemplateId: game.sourceTemplateId,
  name: game.name,
  venue: game.venue,
  address: game.address,
  startsAt: game.startsAt,
  durationMinutes: game.durationMinutes,
  capacity: game.capacity,
  timeZone: game.timeZone,
  registrationOpensAt: game.registrationOpensAt,
  registrationClosesAt: game.registrationClosesAt,
  tentativePromptAt: game.tentativePromptAt,
  tentativeResponseDeadline: game.tentativeResponseDeadline,
  reminderAt: game.reminderAt,
  memberPriorityEnabled: game.memberPriorityEnabled,
  totalCostMinor: game.totalCostMinor,
  currency: game.currency,
  roundingMode: game.roundingMode,
  state: game.state,
  scheduleRevision: game.scheduleRevision,
  canonicalTelegramMessageId: game.canonicalTelegramMessageId,
});

export class GameRepository {
  public constructor(private readonly database: Database) {}

  public async insert(game: Game, actorUserId?: UserId): Promise<Game> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .insert(games)
        .values(insertValues(game))
        .returning();
      if (row === undefined) throw new Error('Game insert returned no row');
      await transaction.insert(outboxEvents).values({
        groupId: row.groupId,
        eventType: 'GAME_CREATED',
        aggregateType: 'GAME',
        aggregateId: row.id,
        payload: { state: row.state },
      });
      await transaction.insert(auditEvents).values({
        groupId: row.groupId,
        actorUserId,
        eventType: 'GAME_CREATED',
        entityType: 'GAME',
        entityId: row.id,
        payload: { state: row.state },
      });
      return toGame(row);
    });
  }

  public async findById(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<Game | null> {
    const [row] = await this.database
      .select()
      .from(games)
      .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
      .limit(1);
    return row === undefined ? null : toGame(row);
  }

  public async listForReconciliation(
    limit: number,
    afterId?: GameId,
  ): Promise<readonly Game[]> {
    const conditions = [
      or(
        inArray(games.state, ['SCHEDULED', 'OPEN', 'CLOSED']),
        sql`EXISTS (
          SELECT 1 FROM ${scheduledJobs}
          WHERE ${scheduledJobs.gameId} = ${games.id}
        )`,
      )!,
      ...(afterId === undefined ? [] : [gt(games.id, afterId)]),
    ];
    const rows = await this.database
      .select()
      .from(games)
      .where(and(...conditions))
      .orderBy(asc(games.id))
      .limit(limit);
    return rows.map(toGame);
  }

  public async withLockedGame<T>(
    groupId: GroupId,
    gameId: GameId,
    callback: (
      game: Game,
      changes: {
        updateState(state: GameState, actorUserId?: UserId): Promise<Game>;
      },
    ) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(games)
        .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
        .for('update')
        .limit(1);
      if (row === undefined) throw new Error('Game not found');

      const updateState = async (
        state: GameState,
        actorUserId?: UserId,
      ): Promise<Game> => {
        const [updated] = await transaction
          .update(games)
          .set({ state, updatedAt: new Date() })
          .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
          .returning();
        if (updated === undefined) throw new Error('Game not found');
        await transaction.insert(auditEvents).values({
          groupId,
          actorUserId,
          eventType: 'GAME_STATE_CHANGED',
          entityType: 'GAME',
          entityId: gameId,
          payload: { from: row.state, to: state },
        });
        await transaction.insert(outboxEvents).values({
          groupId,
          eventType: 'GAME_STATE_CHANGED',
          aggregateType: 'GAME',
          aggregateId: gameId,
          payload: { from: row.state, to: state },
        });
        return toGame(updated);
      };

      return callback(toGame(row), { updateState });
    });
  }
}

const required = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) throw new Error(message);
  return value;
};
