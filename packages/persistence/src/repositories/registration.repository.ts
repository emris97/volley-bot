import {
  asRegistrationId,
  asGroupId,
  asUserId,
  placeConfirmedRegistrations,
  type GameId,
  type GroupId,
  type RegistrationCandidate,
  type RegistrationId,
  type RegistrationState,
  type TelegramId,
  type UserId,
} from '@volley/domain';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import {
  auditEvents,
  games,
  outboxEvents,
  registrations,
  users,
} from '../schema/index.js';

export interface RegisterParticipantInput {
  groupId: GroupId;
  gameId: GameId;
  userId: UserId;
  intent: 'CONFIRMED' | 'TENTATIVE';
  membershipPriority: number;
  idempotencyKey: string;
}

export interface RegistrationResult {
  registrationId: RegistrationId;
  state: RegistrationState;
  rosterPosition?: number;
  waitlistPosition?: number;
}

export interface RegisterGuestInput {
  groupId: GroupId;
  gameId: GameId;
  inviterUserId: UserId;
  guestDisplayName: string;
  idempotencyKey: string;
}

export class RegistrationRepository {
  public constructor(private readonly database: Database) {}

  public async listCandidates(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<readonly RegistrationCandidate[]> {
    const rows = await this.database
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.groupId, groupId),
          eq(registrations.gameId, gameId),
          ne(registrations.state, 'CANCELLED'),
        ),
      );
    return rows.map((row) => ({
      id: asRegistrationId(row.id),
      kind: row.kind,
      state: row.state,
      manualRank: row.manualRank,
      membershipPriority: row.membershipPriority,
      confirmedAt: row.confirmedAt,
    }));
  }

  public async resolve(gameId: GameId, telegramUserId: TelegramId) {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select({ groupId: games.groupId })
        .from(games)
        .where(eq(games.id, gameId))
        .limit(1);
      if (game === undefined) throw new Error('Game not found');
      const [user] = await transaction
        .insert(users)
        .values({ telegramUserId: BigInt(telegramUserId) })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: { updatedAt: new Date() },
        })
        .returning({ id: users.id });
      if (user === undefined) throw new Error('User upsert returned no row');
      const [active] = await transaction
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.gameId, gameId),
            eq(registrations.userId, user.id),
            ne(registrations.state, 'CANCELLED'),
          ),
        )
        .limit(1);
      return {
        groupId: asGroupId(game.groupId),
        gameId,
        userId: asUserId(user.id),
        activeRegistrationId:
          active === undefined ? null : asRegistrationId(active.id),
      };
    });
  }

  public async registerParticipant(
    input: RegisterParticipantInput,
  ): Promise<RegistrationResult> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select()
        .from(games)
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        )
        .for('update')
        .limit(1);
      if (game === undefined) throw new Error('Game not found');
      if (game.state !== 'OPEN')
        throw new Error('Game registration is not open');

      const [existing] = await transaction
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.groupId, input.groupId),
            eq(registrations.gameId, input.gameId),
            eq(registrations.userId, input.userId),
            ne(registrations.state, 'CANCELLED'),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        return resultFor(
          existing.id,
          existing.state,
          await activeCandidates(transaction, input),
        );
      }

      const now = new Date();
      const [created] = await transaction
        .insert(registrations)
        .values({
          groupId: input.groupId,
          gameId: input.gameId,
          userId: input.userId,
          kind: 'MEMBER',
          membershipPriority: input.membershipPriority,
          state: input.intent === 'TENTATIVE' ? 'TENTATIVE' : 'WAITLISTED',
          idempotencyKey: input.idempotencyKey,
          confirmedAt: input.intent === 'CONFIRMED' ? now : null,
        })
        .returning();
      if (created === undefined)
        throw new Error('Registration insert returned no row');

      const active = await activeCandidates(transaction, input);
      const placement = placeConfirmedRegistrations({
        capacity: game.capacity,
        registrations: active,
      });
      await Promise.all([
        ...placement.roster.map((item) =>
          transaction
            .update(registrations)
            .set({ state: 'ROSTERED', updatedAt: now })
            .where(eq(registrations.id, item.id)),
        ),
        ...placement.waitlist.map((item) =>
          transaction
            .update(registrations)
            .set({ state: 'WAITLISTED', updatedAt: now })
            .where(eq(registrations.id, item.id)),
        ),
      ]);

      const finalState =
        input.intent === 'TENTATIVE'
          ? 'TENTATIVE'
          : placement.roster.some((item) => item.id === created.id)
            ? 'ROSTERED'
            : 'WAITLISTED';
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.userId,
        eventType: 'PARTICIPANT_REGISTERED',
        entityType: 'REGISTRATION',
        entityId: created.id,
        payload: { state: finalState },
      });
      await transaction.insert(outboxEvents).values({
        groupId: input.groupId,
        eventType: 'REGISTRATION_CHANGED',
        aggregateType: 'GAME',
        aggregateId: input.gameId,
        payload: { registrationId: created.id, state: finalState },
      });
      const placed = [
        ...placement.roster.map((item) => ({
          ...item,
          state: 'ROSTERED' as const,
        })),
        ...placement.waitlist.map((item) => ({
          ...item,
          state: 'WAITLISTED' as const,
        })),
      ];
      return resultFor(created.id, finalState, placed);
    });
  }

  public async registerGuest(
    input: RegisterGuestInput,
  ): Promise<RegistrationResult> {
    return this.database.transaction(async (transaction) => {
      const game = await lockOpenGame(transaction, input.groupId, input.gameId);
      const [byKey] = await transaction
        .select()
        .from(registrations)
        .where(eq(registrations.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (byKey !== undefined) {
        return resultFor(
          byKey.id,
          byKey.state,
          await activeCandidates(transaction, input),
        );
      }

      const now = new Date();
      const [created] = await transaction
        .insert(registrations)
        .values({
          groupId: input.groupId,
          gameId: input.gameId,
          inviterUserId: input.inviterUserId,
          guestDisplayName: input.guestDisplayName,
          kind: 'GUEST',
          membershipPriority: 0,
          state: 'WAITLISTED',
          idempotencyKey: input.idempotencyKey,
          confirmedAt: now,
        })
        .returning();
      if (created === undefined)
        throw new Error('Registration insert returned no row');
      const placement = await recalculatePlacement(
        transaction,
        input,
        game.capacity,
        now,
      );
      const state = placement.roster.some((item) => item.id === created.id)
        ? 'ROSTERED'
        : 'WAITLISTED';
      await recordChange(transaction, {
        groupId: input.groupId,
        gameId: input.gameId,
        registrationId: created.id,
        actorUserId: input.inviterUserId,
        eventType: 'GUEST_REGISTERED',
        payload: { state, guestDisplayName: input.guestDisplayName },
      });
      return resultFor(created.id, state, [
        ...placement.roster.map((item) => ({
          ...item,
          state: 'ROSTERED' as const,
        })),
        ...placement.waitlist.map((item) => ({
          ...item,
          state: 'WAITLISTED' as const,
        })),
      ]);
    });
  }

  public async withdraw(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
    reason: string;
    allowOrganizerOverride?: boolean;
  }): Promise<RegistrationResult> {
    return this.database.transaction(async (transaction) => {
      const game = await lockOpenGame(transaction, input.groupId, input.gameId);
      const [registration] = await transaction
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.groupId, input.groupId),
            eq(registrations.gameId, input.gameId),
            eq(registrations.id, input.registrationId),
          ),
        )
        .for('update')
        .limit(1);
      if (registration === undefined) throw new Error('Registration not found');
      if (
        input.allowOrganizerOverride !== true &&
        registration.userId !== input.actorUserId &&
        registration.inviterUserId !== input.actorUserId
      ) {
        throw new Error(
          'Participants may withdraw only their own registration',
        );
      }
      if (registration.state === 'CANCELLED') {
        return resultFor(registration.id, 'CANCELLED', []);
      }
      const now = new Date();
      await transaction
        .update(registrations)
        .set({
          state: 'CANCELLED',
          cancelledAt: now,
          cancellationReason: input.reason,
          updatedAt: now,
        })
        .where(eq(registrations.id, input.registrationId));
      await recalculatePlacement(transaction, input, game.capacity, now);
      await recordChange(transaction, {
        groupId: input.groupId,
        gameId: input.gameId,
        registrationId: input.registrationId,
        actorUserId: input.actorUserId,
        eventType: 'REGISTRATION_WITHDRAWN',
        payload: { reason: input.reason },
      });
      return resultFor(input.registrationId, 'CANCELLED', []);
    });
  }

  public async changeManualRank(input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: RegistrationId;
    actorUserId: UserId;
    manualRank: number | null;
    reason: string;
  }): Promise<RegistrationResult> {
    return this.database.transaction(async (transaction) => {
      const game = await lockOpenGame(transaction, input.groupId, input.gameId);
      const now = new Date();
      const [updated] = await transaction
        .update(registrations)
        .set({ manualRank: input.manualRank, updatedAt: now })
        .where(
          and(
            eq(registrations.groupId, input.groupId),
            eq(registrations.gameId, input.gameId),
            eq(registrations.id, input.registrationId),
            ne(registrations.state, 'CANCELLED'),
          ),
        )
        .returning();
      if (updated === undefined) throw new Error('Registration not found');
      const placement = await recalculatePlacement(
        transaction,
        input,
        game.capacity,
        now,
      );
      const state = placement.roster.some((item) => item.id === updated.id)
        ? 'ROSTERED'
        : updated.state === 'TENTATIVE'
          ? 'TENTATIVE'
          : 'WAITLISTED';
      await recordChange(transaction, {
        groupId: input.groupId,
        gameId: input.gameId,
        registrationId: input.registrationId,
        actorUserId: input.actorUserId,
        eventType: 'REGISTRATION_ORDER_CHANGED',
        payload: { manualRank: input.manualRank, reason: input.reason },
      });
      return resultFor(updated.id, state, [
        ...placement.roster.map((item) => ({
          ...item,
          state: 'ROSTERED' as const,
        })),
        ...placement.waitlist.map((item) => ({
          ...item,
          state: 'WAITLISTED' as const,
        })),
      ]);
    });
  }

  public async updateGame(input: {
    groupId: GroupId;
    gameId: GameId;
    actorUserId: UserId;
    expectedRevision: number;
    changes: { capacity?: number };
  }): Promise<{
    scheduleRevision: number;
    rosterCount: number;
    waitlistCount: number;
  }> {
    return this.database.transaction(async (transaction) => {
      const [game] = await transaction
        .select()
        .from(games)
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        )
        .for('update')
        .limit(1);
      if (game === undefined) throw new Error('Game not found');
      if (game.scheduleRevision !== input.expectedRevision) {
        throw new Error('Stale game revision');
      }
      const scheduleRevision = game.scheduleRevision + 1;
      const capacity = input.changes.capacity ?? game.capacity;
      const now = new Date();
      await transaction
        .update(games)
        .set({ capacity, scheduleRevision, updatedAt: now })
        .where(
          and(eq(games.groupId, input.groupId), eq(games.id, input.gameId)),
        );
      const placement = await recalculatePlacement(
        transaction,
        input,
        capacity,
        now,
      );
      await transaction.insert(auditEvents).values({
        groupId: input.groupId,
        actorUserId: input.actorUserId,
        eventType: 'GAME_UPDATED',
        entityType: 'GAME',
        entityId: input.gameId,
        payload: { capacity, scheduleRevision },
      });
      await transaction.insert(outboxEvents).values({
        groupId: input.groupId,
        eventType: 'GAME_UPDATED',
        aggregateType: 'GAME',
        aggregateId: input.gameId,
        payload: { capacity, scheduleRevision },
      });
      return {
        scheduleRevision,
        rosterCount: placement.roster.length,
        waitlistCount: placement.waitlist.length,
      };
    });
  }
}

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const activeCandidates = async (
  transaction: Transaction,
  input: Pick<RegisterParticipantInput, 'groupId' | 'gameId'>,
): Promise<RegistrationCandidate[]> => {
  const rows = await transaction
    .select()
    .from(registrations)
    .where(
      and(
        eq(registrations.groupId, input.groupId),
        eq(registrations.gameId, input.gameId),
        ne(registrations.state, 'CANCELLED'),
      ),
    )
    .for('update');
  return rows.map((row) => ({
    id: asRegistrationId(row.id),
    kind: row.kind,
    state: row.state,
    manualRank: row.manualRank,
    membershipPriority: row.membershipPriority,
    confirmedAt: row.confirmedAt,
  }));
};

const lockOpenGame = async (
  transaction: Transaction,
  groupId: GroupId,
  gameId: GameId,
) => {
  const [game] = await transaction
    .select()
    .from(games)
    .where(and(eq(games.groupId, groupId), eq(games.id, gameId)))
    .for('update')
    .limit(1);
  if (game === undefined) throw new Error('Game not found');
  if (game.state !== 'OPEN') throw new Error('Game registration is not open');
  return game;
};

const recalculatePlacement = async (
  transaction: Transaction,
  input: { groupId: GroupId; gameId: GameId },
  capacity: number,
  now: Date,
) => {
  const active = await activeCandidates(transaction, input);
  const placement = placeConfirmedRegistrations({
    capacity,
    registrations: active,
  });
  for (const item of placement.roster) {
    await transaction
      .update(registrations)
      .set({ state: 'ROSTERED', updatedAt: now })
      .where(eq(registrations.id, item.id));
  }
  for (const item of placement.waitlist) {
    await transaction
      .update(registrations)
      .set({ state: 'WAITLISTED', updatedAt: now })
      .where(eq(registrations.id, item.id));
  }
  return placement;
};

const recordChange = async (
  transaction: Transaction,
  input: {
    groupId: GroupId;
    gameId: GameId;
    registrationId: string;
    actorUserId: UserId;
    eventType: string;
    payload: Record<string, unknown>;
  },
) => {
  await transaction.insert(auditEvents).values({
    groupId: input.groupId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    entityType: 'REGISTRATION',
    entityId: input.registrationId,
    payload: input.payload,
  });
  await transaction.insert(outboxEvents).values({
    groupId: input.groupId,
    eventType: 'REGISTRATION_CHANGED',
    aggregateType: 'GAME',
    aggregateId: input.gameId,
    payload: { registrationId: input.registrationId, ...input.payload },
  });
};

const resultFor = (
  id: string,
  state: RegistrationState,
  active: readonly RegistrationCandidate[],
): RegistrationResult => {
  const sameState = active.filter((item) => item.state === state);
  const position = sameState.findIndex((item) => item.id === id);
  return {
    registrationId: asRegistrationId(id),
    state,
    ...(state === 'ROSTERED' && position >= 0
      ? { rosterPosition: position + 1 }
      : {}),
    ...(state === 'WAITLISTED' && position >= 0
      ? { waitlistPosition: position + 1 }
      : {}),
  };
};
