import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  AuthorizationDeniedError,
  AuthorizationService,
  type AuthenticatedPrincipal,
} from '@volley/application';
import { v1 } from '@volley/contracts';
import type { GameResponse } from '@volley/contracts/v1';
import {
  asGameId,
  asGroupId,
  type Game,
  type GameId,
  type GroupId,
} from '@volley/domain';
import { MiniAppAuthGuard, Principal } from '../auth/auth.guard.js';

const { GameParamsSchema, GameResponseSchema } = v1;

export const GAME_QUERIES = Symbol('GAME_QUERIES');

export interface GameQueries {
  getGame(groupId: GroupId, gameId: GameId): Promise<Game | null>;
}

@Controller('/api/v1')
@UseGuards(MiniAppAuthGuard)
export class GamesController {
  public constructor(
    private readonly authorization: AuthorizationService,
    @Inject(GAME_QUERIES) private readonly queries: GameQueries,
  ) {}

  @Get('/groups/:groupId/games/:gameId')
  public async getGame(
    @Principal() principal: AuthenticatedPrincipal,
    @Param() rawParams: unknown,
  ): Promise<GameResponse> {
    const parsed = GameParamsSchema.safeParse(rawParams);
    if (!parsed.success) throw new BadRequestException('Invalid game path');
    const groupId = asGroupId(parsed.data.groupId);
    const gameId = asGameId(parsed.data.gameId);
    try {
      await this.authorization.requireRole(groupId, principal, 'MEMBER');
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        throw new ForbiddenException();
      }
      throw error;
    }

    const game = await this.queries.getGame(groupId, gameId);
    if (game === null) throw new NotFoundException('Game not found');
    return GameResponseSchema.parse({
      id: game.id,
      groupId: game.groupId,
      name: game.name,
      venue: game.venue,
      address: game.address,
      startsAt: game.startsAt.toISOString(),
      durationMinutes: game.durationMinutes,
      capacity: game.capacity,
      timeZone: game.timeZone,
      registrationOpensAt: game.registrationOpensAt.toISOString(),
      registrationClosesAt: game.registrationClosesAt?.toISOString() ?? null,
      memberPriorityEnabled: game.memberPriorityEnabled,
      totalCostMinor: game.totalCostMinor?.toString() ?? null,
      currency: game.currency,
      roundingMode: game.roundingMode,
      state: game.state,
      scheduleRevision: game.scheduleRevision,
    });
  }
}
