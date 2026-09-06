import {
  AuthorizationDeniedError,
  type DraftGameRepository,
  type GameCreationDraft,
  type GameListBucket,
  type GameListRepository,
  type GamePublicationRepository,
} from '@volley/application';
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
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  auditEvents,
  gameCreationDrafts,
  games,
  groupMembers,
  outboxEvents,
  registrations,
  scheduledJobs,
} from '../schema/index.js';
import {
  parseGameCreationDraftData,
  serializeGameCreationDraftData,
} from './game-creation-draft.repository.js';

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
  revision: row.revision,
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
  revision: game.revision,
  scheduleRevision: game.scheduleRevision,
  canonicalTelegramMessageId: game.canonicalTelegramMessageId,
});

export class GameRepository
  implements GamePublicationRepository, GameListRepository, DraftGameRepository
{
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

  public async publishDraft(
    input: {
      groupId: GroupId;
      actorUserId: UserId;
      draftId: string;
      expectedStep: GameCreationDraft['step'];
      expectedViewRevision: number;
      now: Date;
    },
    build: (draft: GameCreationDraft) => Game,
  ): Promise<{ game: Game; created: boolean }> {
    return this.database.transaction(async (transaction) => {
      const [membership] = await transaction
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, input.groupId),
            eq(groupMembers.userId, input.actorUserId),
            eq(groupMembers.membershipStatus, 'ACTIVE'),
            inArray(groupMembers.role, ['OWNER', 'ADMIN', 'ORGANIZER']),
          ),
        )
        .for('update')
        .limit(1);
      if (membership === undefined) throw new AuthorizationDeniedError();

      const [draftRow] = await transaction
        .select()
        .from(gameCreationDrafts)
        .where(
          and(
            eq(gameCreationDrafts.groupId, input.groupId),
            eq(gameCreationDrafts.actorUserId, input.actorUserId),
          ),
        )
        .for('update')
        .limit(1);
      if (draftRow === undefined) {
        throw new Error('Game creation draft is stale');
      }
      const draft = parseGameCreationDraftData(
        draftRow.data,
        asGroupId(draftRow.groupId),
        input.actorUserId,
      );
      if (
        draft.draftId !== input.draftId ||
        (draft.step !== input.expectedStep &&
          !(draft.step === 'PUBLISHED' && input.expectedStep === 'PREVIEW')) ||
        (draft.viewRevision ?? 0) !== input.expectedViewRevision ||
        draft.cancelPending === true
      ) {
        throw new Error('Game creation draft is stale');
      }
      if (
        !draft.previewed ||
        draft.snapshot === undefined ||
        draft.startsAtIso === undefined ||
        (draft.step !== 'PREVIEW' && draft.step !== 'PUBLISHED')
      ) {
        throw new Error('Complete game preview is required before publish');
      }
      if (draft.publishedGameId !== undefined) {
        const [published] = await transaction
          .select()
          .from(games)
          .where(
            and(
              eq(games.groupId, input.groupId),
              eq(games.id, draft.publishedGameId),
            ),
          )
          .limit(1);
        if (published === undefined)
          throw new Error('Published game not found');
        return { game: toGame(published), created: false };
      }

      const game = { ...build(draft), revision: 0 };
      if (game.groupId !== input.groupId) {
        throw new Error('Published game group does not match draft');
      }
      const [created] = await transaction
        .insert(games)
        .values(insertValues(game))
        .returning();
      if (created === undefined) throw new Error('Game insert returned no row');
      await transaction.insert(outboxEvents).values({
        groupId: created.groupId,
        eventType: 'GAME_CREATED',
        aggregateType: 'GAME',
        aggregateId: created.id,
        payload: { state: created.state },
      });
      await transaction.insert(auditEvents).values({
        groupId: created.groupId,
        actorUserId: input.actorUserId,
        eventType: 'GAME_CREATED',
        entityType: 'GAME',
        entityId: created.id,
        payload: { state: created.state },
      });
      await transaction
        .update(gameCreationDrafts)
        .set({
          data: serializeGameCreationDraftData({
            ...draft,
            step: 'PUBLISHED',
            cancelPending: false,
            publishedGameId: asGameId(created.id),
          }),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(gameCreationDrafts.groupId, input.groupId),
            eq(gameCreationDrafts.actorUserId, input.actorUserId),
          ),
        );
      return { game: toGame(created), created: true };
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

  public async list(
    groupId: GroupId,
    options: {
      bucket: GameListBucket;
      limit: 8;
      cursor?: GameId | null;
    },
  ): Promise<{ items: readonly Game[]; nextCursor: GameId | null }> {
    if (options.limit !== 8) throw new Error('Game lists contain eight items');
    const ascending = options.bucket === 'UPCOMING';
    const states: readonly GameState[] =
      options.bucket === 'UPCOMING'
        ? ['DRAFT', 'SCHEDULED', 'OPEN', 'CLOSED']
        : options.bucket === 'HISTORY'
          ? ['COMPLETED', 'CANCELLED']
          : ['CANCELLED'];
    const cursor =
      options.cursor == null
        ? undefined
        : ascending
          ? sql`(
              ${games.startsAt} > (
                SELECT starts_at FROM games
                WHERE id = ${options.cursor} AND group_id = ${groupId}
              ) OR (
                ${games.startsAt} = (
                  SELECT starts_at FROM games
                  WHERE id = ${options.cursor} AND group_id = ${groupId}
                ) AND ${games.id} > ${options.cursor}
              )
            )`
          : sql`(
              ${games.startsAt} < (
                SELECT starts_at FROM games
                WHERE id = ${options.cursor} AND group_id = ${groupId}
              ) OR (
                ${games.startsAt} = (
                  SELECT starts_at FROM games
                  WHERE id = ${options.cursor} AND group_id = ${groupId}
                ) AND ${games.id} < ${options.cursor}
              )
            )`;
    const rows = await this.database
      .select()
      .from(games)
      .where(
        and(
          eq(games.groupId, groupId),
          inArray(games.state, states),
          ...(cursor === undefined ? [] : [cursor]),
        ),
      )
      .orderBy(
        ascending ? asc(games.startsAt) : desc(games.startsAt),
        ascending ? asc(games.id) : desc(games.id),
      )
      .limit(options.limit + 1);
    const hasNextPage = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map(toGame);
    return {
      items,
      nextCursor: hasNextPage ? (items.at(-1)?.id ?? null) : null,
    };
  }

  public async deleteDraft(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
    expectedRevision: number;
  }): Promise<'DELETED' | 'NOT_FOUND' | 'STALE' | 'NOT_DELETABLE'> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select({
          state: games.state,
          revision: games.revision,
          canonicalTelegramMessageId: games.canonicalTelegramMessageId,
        })
        .from(games)
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        )
        .for('update')
        .limit(1);
      if (game === undefined) return 'NOT_FOUND';
      if (game.revision !== input.expectedRevision) return 'STALE';
      if (game.state !== 'DRAFT' || game.canonicalTelegramMessageId !== null) {
        return 'NOT_DELETABLE';
      }
      const [registration] = await transaction
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.groupId, input.groupId),
            eq(registrations.gameId, input.gameId),
          ),
        )
        .limit(1);
      if (registration !== undefined) return 'NOT_DELETABLE';
      const [deleted] = await transaction
        .delete(games)
        .where(
          and(
            eq(games.groupId, input.groupId),
            eq(games.id, input.gameId),
            eq(games.state, 'DRAFT'),
            eq(games.revision, input.expectedRevision),
            isNull(games.canonicalTelegramMessageId),
          ),
        )
        .returning({ id: games.id });
      if (deleted === undefined) return 'STALE';
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        eventType: 'GAME_DRAFT_DELETED',
        entityType: 'GAME',
        entityId: input.gameId,
        payload: { revision: input.expectedRevision },
      });
      return 'DELETED';
    });
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
          .set({
            state,
            revision: sql`${games.revision} + 1`,
            updatedAt: new Date(),
          })
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
