import type {
  ClearGameEditSessionInput,
  GameEditSession,
  GameEditableField,
  GameUpdateChanges,
  SaveGameEditSessionChangesInput,
  StartGameEditSessionInput,
} from '@volley/application';
import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asTelegramId,
  asUserId,
  type Game,
  type GameId,
  type GameState,
  type GroupId,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  attendanceEntries,
  attendanceSnapshots,
  gameEditSessions,
  games,
  groupMembers,
  groups,
  registrations,
  settlementCharges,
  settlements,
  users,
} from '../schema/index.js';

export interface ManagementContextRecord {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  telegramChatId: TelegramId;
  game: Game;
  gameState: GameState;
  dmAvailable: boolean;
  registrationCount: number;
  rosterCount: number;
  waitlistCount: number;
  hasFinalizedAttendance: boolean;
  canonicalPinFailedAt: Date | null;
}

export interface ManagementSummary {
  participationCount: number;
  attendance: {
    presentCount: number;
    billableCount: number;
  } | null;
  settlement: {
    totalMinor: bigint;
    paidCount: number;
    paidMinor: bigint;
    unpaidCount: number;
    unpaidMinor: bigint;
    waivedCount: number;
    waivedMinor: bigint;
  } | null;
}

export class ManagementRepository {
  public constructor(private readonly database: Database) {}

  public async resolveGameGroup(gameId: GameId): Promise<{
    groupId: GroupId;
    telegramChatId: TelegramId;
  } | null> {
    const [row] = await this.database
      .select({
        groupId: games.groupId,
        telegramChatId: groups.telegramChatId,
      })
      .from(games)
      .innerJoin(groups, eq(groups.id, games.groupId))
      .where(eq(games.id, gameId))
      .limit(1);
    return row === undefined
      ? null
      : {
          groupId: asGroupId(row.groupId),
          telegramChatId: asTelegramId(row.telegramChatId.toString()),
        };
  }

  public async refreshMembership(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId> {
    return this.database.transaction(async (transaction) => {
      const now = new Date();
      const [user] = await transaction
        .insert(users)
        .values({ telegramUserId: BigInt(input.telegramUserId) })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { updatedAt: now },
        })
        .returning({ id: users.id });
      if (user === undefined) throw new Error('User upsert returned no row');
      await transaction
        .insert(groupMembers)
        .values({
          groupId: input.groupId,
          userId: user.id,
          role: input.role,
          membershipStatus: input.status,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [groupMembers.groupId, groupMembers.userId],
          set: {
            role: input.role,
            membershipStatus: input.status,
            checkedAt: now,
            updatedAt: now,
          },
        });
      return asUserId(user.id);
    });
  }

  public async resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<ManagementContextRecord | null> {
    const [game] = await this.database
      .select({ game: games, telegramChatId: groups.telegramChatId })
      .from(games)
      .innerJoin(groups, eq(groups.id, games.groupId))
      .where(eq(games.id, gameId))
      .limit(1);
    if (game === undefined) return null;
    const [actor] = await this.database
      .select({
        userId: users.id,
        dmAvailableAt: users.dmAvailableAt,
      })
      .from(users)
      .innerJoin(
        groupMembers,
        and(
          eq(groupMembers.userId, users.id),
          eq(groupMembers.groupId, game.game.groupId),
        ),
      )
      .where(eq(users.telegramUserId, BigInt(telegramUserId)))
      .limit(1);
    if (actor === undefined) return null;
    const [attendance] = await this.database
      .select({ revision: attendanceSnapshots.revision })
      .from(attendanceSnapshots)
      .where(
        and(
          eq(attendanceSnapshots.groupId, game.game.groupId),
          eq(attendanceSnapshots.gameId, gameId),
          eq(attendanceSnapshots.finalized, true),
        ),
      )
      .orderBy(desc(attendanceSnapshots.revision))
      .limit(1);
    const [counts] = await this.database
      .select({
        registrationCount: sql<number>`count(*)::integer`,
        rosterCount: sql<number>`count(*) filter (where ${registrations.state} = 'ROSTERED')::integer`,
        waitlistCount: sql<number>`count(*) filter (where ${registrations.state} = 'WAITLISTED')::integer`,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.groupId, game.game.groupId),
          eq(registrations.gameId, gameId),
        ),
      );
    return {
      groupId: asGroupId(game.game.groupId),
      gameId: asGameId(gameId),
      userId: asUserId(actor.userId),
      telegramChatId: asTelegramId(game.telegramChatId.toString()),
      game: toGame(game.game),
      gameState: game.game.state,
      dmAvailable: actor.dmAvailableAt !== null,
      registrationCount: counts?.registrationCount ?? 0,
      rosterCount: counts?.rosterCount ?? 0,
      waitlistCount: counts?.waitlistCount ?? 0,
      hasFinalizedAttendance: attendance !== undefined,
      canonicalPinFailedAt: game.game.canonicalPinFailedAt,
    };
  }

  public async markPrivateAvailable(telegramUserId: TelegramId): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: new Date(), updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }

  public async markPrivateUnavailable(
    telegramUserId: TelegramId,
  ): Promise<void> {
    await this.database
      .update(users)
      .set({ dmAvailableAt: null, updatedAt: new Date() })
      .where(eq(users.telegramUserId, BigInt(telegramUserId)));
  }

  public async startEditSession(
    input: StartGameEditSessionInput,
  ): Promise<GameEditSession> {
    const now = new Date();
    const [row] = await this.database
      .insert(gameEditSessions)
      .values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        gameId: input.gameId,
        expectedGameRevision: input.expectedGameRevision,
        selectedField: input.selectedField,
        interactionRevision: 0,
        pendingChanges: null,
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [gameEditSessions.groupId, gameEditSessions.actorUserId],
        set: {
          gameId: input.gameId,
          expectedGameRevision: input.expectedGameRevision,
          selectedField: input.selectedField,
          interactionRevision: sql`${gameEditSessions.interactionRevision} + 1`,
          pendingChanges: null,
          active: true,
          updatedAt: now,
        },
      })
      .returning();
    if (row === undefined) throw new Error('Game edit session returned no row');
    return toGameEditSession(row);
  }

  public async resolveLatestEditScope(
    telegramUserId: TelegramId,
  ): Promise<{ groupId: GroupId; actorUserId: UserId } | null> {
    const [row] = await this.database
      .select({
        groupId: gameEditSessions.groupId,
        actorUserId: gameEditSessions.actorUserId,
      })
      .from(gameEditSessions)
      .innerJoin(users, eq(users.id, gameEditSessions.actorUserId))
      .where(
        and(
          eq(users.telegramUserId, BigInt(telegramUserId)),
          eq(gameEditSessions.active, true),
        ),
      )
      .orderBy(desc(gameEditSessions.updatedAt))
      .limit(1);
    return row === undefined
      ? null
      : {
          groupId: asGroupId(row.groupId),
          actorUserId: asUserId(row.actorUserId),
        };
  }

  public async loadEditSession(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<GameEditSession | null> {
    const [row] = await this.database
      .select()
      .from(gameEditSessions)
      .where(
        and(
          eq(gameEditSessions.groupId, groupId),
          eq(gameEditSessions.actorUserId, actorUserId),
          eq(gameEditSessions.active, true),
        ),
      )
      .limit(1);
    return row === undefined ? null : toGameEditSession(row);
  }

  public async saveEditSessionChanges(
    input: SaveGameEditSessionChangesInput,
  ): Promise<GameEditSession | null> {
    const serialized = serializePendingChanges(input.pendingChanges);
    const selectedField = singleChangedField(input.pendingChanges);
    const [row] = await this.database
      .update(gameEditSessions)
      .set({
        interactionRevision: sql`${gameEditSessions.interactionRevision} + 1`,
        pendingChanges: serialized,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameEditSessions.groupId, input.groupId),
          eq(gameEditSessions.actorUserId, input.actorUserId),
          eq(gameEditSessions.gameId, input.gameId),
          eq(gameEditSessions.expectedGameRevision, input.expectedGameRevision),
          eq(
            gameEditSessions.interactionRevision,
            input.expectedInteractionRevision,
          ),
          eq(gameEditSessions.selectedField, selectedField),
          eq(gameEditSessions.active, true),
        ),
      )
      .returning();
    return row === undefined ? null : toGameEditSession(row);
  }

  public async clearEditSession(
    input: ClearGameEditSessionInput,
  ): Promise<boolean> {
    const [row] = await this.database
      .update(gameEditSessions)
      .set({
        interactionRevision: sql`${gameEditSessions.interactionRevision} + 1`,
        pendingChanges: null,
        active: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameEditSessions.groupId, input.groupId),
          eq(gameEditSessions.actorUserId, input.actorUserId),
          eq(gameEditSessions.gameId, input.gameId),
          eq(
            gameEditSessions.interactionRevision,
            input.expectedInteractionRevision,
          ),
          eq(gameEditSessions.active, true),
        ),
      )
      .returning({ groupId: gameEditSessions.groupId });
    return row !== undefined;
  }

  public async loadSummary(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<ManagementSummary | null> {
    const [game] = await this.database
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
      .limit(1);
    if (game === undefined) return null;

    const [participation] = await this.database
      .select({ count: sql<number>`count(*)::integer` })
      .from(registrations)
      .where(
        and(
          eq(registrations.groupId, groupId),
          eq(registrations.gameId, gameId),
          ne(registrations.state, 'CANCELLED'),
        ),
      );
    const [snapshot] = await this.database
      .select({ id: attendanceSnapshots.id })
      .from(attendanceSnapshots)
      .where(
        and(
          eq(attendanceSnapshots.groupId, groupId),
          eq(attendanceSnapshots.gameId, gameId),
          eq(attendanceSnapshots.finalized, true),
        ),
      )
      .orderBy(desc(attendanceSnapshots.revision))
      .limit(1);
    const attendance =
      snapshot === undefined
        ? null
        : summarizeAttendance(
            await this.database
              .select({ billable: attendanceEntries.billable })
              .from(attendanceEntries)
              .where(
                and(
                  eq(attendanceEntries.groupId, groupId),
                  eq(attendanceEntries.snapshotId, snapshot.id),
                ),
              ),
          );
    const [settlement] = await this.database
      .select({ id: settlements.id, totalMinor: settlements.totalMinor })
      .from(settlements)
      .where(
        and(
          eq(settlements.groupId, groupId),
          eq(settlements.gameId, gameId),
          isNull(settlements.supersededAt),
        ),
      )
      .limit(1);
    const settlementSummary =
      settlement === undefined
        ? null
        : summarizeSettlement(
            settlement.totalMinor,
            await this.database
              .select({
                status: settlementCharges.status,
                amountMinor: settlementCharges.amountMinor,
              })
              .from(settlementCharges)
              .where(
                and(
                  eq(settlementCharges.groupId, groupId),
                  eq(settlementCharges.settlementId, settlement.id),
                ),
              ),
          );
    return {
      participationCount: participation?.count ?? 0,
      attendance,
      settlement: settlementSummary,
    };
  }
}

type GameEditSessionRow = typeof gameEditSessions.$inferSelect;

const toGameEditSession = (row: GameEditSessionRow): GameEditSession => ({
  groupId: asGroupId(row.groupId),
  actorUserId: asUserId(row.actorUserId),
  gameId: asGameId(row.gameId),
  expectedGameRevision: row.expectedGameRevision,
  selectedField: row.selectedField,
  interactionRevision: row.interactionRevision,
  pendingChanges:
    row.pendingChanges === null
      ? null
      : parsePendingChanges(row.pendingChanges, row.selectedField),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const singleChangedField = (changes: GameUpdateChanges): GameEditableField => {
  const fields = Object.keys(changes) as GameEditableField[];
  if (fields.length !== 1 || changes[fields[0]!] === undefined) {
    throw new Error('Invalid game edit session changes');
  }
  return fields[0]!;
};

const serializePendingChanges = (
  changes: GameUpdateChanges,
): Record<string, unknown> => {
  const field = singleChangedField(changes);
  const value = changes[field];
  return {
    version: 1,
    field,
    ...(value instanceof Date
      ? { kind: 'date', value: value.toISOString() }
      : typeof value === 'bigint'
        ? { kind: 'bigint', value: value.toString() }
        : value === null
          ? { kind: 'null' }
          : { kind: typeof value, value }),
  };
};

const parsePendingChanges = (
  stored: Record<string, unknown>,
  selectedField: GameEditableField,
): GameUpdateChanges => {
  if (
    stored.version !== 1 ||
    stored.field !== selectedField ||
    typeof stored.kind !== 'string'
  ) {
    throw new Error('Invalid game edit session changes');
  }
  let value: string | number | boolean | bigint | Date | null;
  if (stored.kind === 'null') {
    value = null;
  } else if (stored.kind === 'date' && typeof stored.value === 'string') {
    value = new Date(stored.value);
    if (Number.isNaN(value.getTime()) || value.toISOString() !== stored.value) {
      throw new Error('Invalid game edit session date');
    }
  } else if (
    stored.kind === 'bigint' &&
    typeof stored.value === 'string' &&
    /^\d+$/.test(stored.value)
  ) {
    value = BigInt(stored.value);
  } else if (
    (stored.kind === 'string' && typeof stored.value === 'string') ||
    (stored.kind === 'number' && Number.isSafeInteger(stored.value)) ||
    (stored.kind === 'boolean' && typeof stored.value === 'boolean')
  ) {
    value = stored.value as string | number | boolean;
  } else {
    throw new Error('Invalid game edit session value');
  }
  return { [selectedField]: value } as GameUpdateChanges;
};

const summarizeAttendance = (
  entries: readonly { billable: boolean }[],
): NonNullable<ManagementSummary['attendance']> => ({
  presentCount: entries.length,
  billableCount: entries.filter(({ billable }) => billable).length,
});

const summarizeSettlement = (
  totalMinor: bigint,
  charges: readonly {
    status: 'UNPAID' | 'PAID' | 'WAIVED';
    amountMinor: bigint;
  }[],
): NonNullable<ManagementSummary['settlement']> => {
  const summary = {
    totalMinor,
    paidCount: 0,
    paidMinor: 0n,
    unpaidCount: 0,
    unpaidMinor: 0n,
    waivedCount: 0,
    waivedMinor: 0n,
  };
  for (const charge of charges) {
    if (charge.status === 'PAID') {
      summary.paidCount += 1;
      summary.paidMinor += charge.amountMinor;
    } else if (charge.status === 'UNPAID') {
      summary.unpaidCount += 1;
      summary.unpaidMinor += charge.amountMinor;
    } else {
      summary.waivedCount += 1;
      summary.waivedMinor += charge.amountMinor;
    }
  }
  return summary;
};

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
