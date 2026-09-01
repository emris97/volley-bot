import { Module } from '@nestjs/common';
import { AuthorizationService, GetGame } from '@volley/application';
import type { AppEnv } from '@volley/config';
import {
  type Database,
  GameRepository,
  GroupRepository,
} from '@volley/persistence';
import { APP_ENV, DATABASE } from '../infrastructure/infrastructure.module.js';
import {
  AUTHENTICATED_PRINCIPAL_RESOLVER,
  MINI_APP_INIT_DATA_VERIFIER,
  MiniAppAuthGuard,
  type AuthenticatedPrincipalResolver,
} from '../auth/auth.guard.js';
import { MiniAppInitDataVerifier } from '../auth/mini-app-init-data.verifier.js';
import {
  GAME_QUERIES,
  GamesController,
  type GameQueries,
} from './games.controller.js';

const V1_RUNTIME = Symbol('V1_RUNTIME');

interface V1Runtime {
  games: GameRepository;
  groups: GroupRepository;
}

@Module({
  controllers: [GamesController],
  providers: [
    {
      provide: V1_RUNTIME,
      inject: [DATABASE],
      useFactory: (database: Database): V1Runtime => ({
        games: new GameRepository(database),
        groups: new GroupRepository(database),
      }),
    },
    {
      provide: MINI_APP_INIT_DATA_VERIFIER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): MiniAppInitDataVerifier =>
        new MiniAppInitDataVerifier(env.BOT_TOKEN),
    },
    {
      provide: AUTHENTICATED_PRINCIPAL_RESOLVER,
      inject: [V1_RUNTIME],
      useFactory: (runtime: V1Runtime): AuthenticatedPrincipalResolver => ({
        resolve: (telegramUserId) =>
          runtime.groups.findUserIdByTelegramUserId(telegramUserId),
      }),
    },
    {
      provide: AuthorizationService,
      inject: [V1_RUNTIME],
      useFactory: (runtime: V1Runtime): AuthorizationService =>
        new AuthorizationService({
          findMembership: (groupId, userId) =>
            runtime.groups.findMembershipByUserId(groupId, userId),
          findMembershipByTelegramUserId: (groupId, telegramUserId) =>
            runtime.groups.findMembership(groupId, telegramUserId),
        }),
    },
    {
      provide: GAME_QUERIES,
      inject: [V1_RUNTIME],
      useFactory: (runtime: V1Runtime): GameQueries =>
        new GetGame(runtime.games),
    },
    MiniAppAuthGuard,
  ],
})
export class V1Module {}
