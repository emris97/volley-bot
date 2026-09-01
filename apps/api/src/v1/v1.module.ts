import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AuthorizationService, GetGame } from '@volley/application';
import { parseEnv, type AppEnv } from '@volley/config';
import {
  createDatabase,
  GameRepository,
  GroupRepository,
} from '@volley/persistence';
import { Pool } from 'pg';
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

const V1_ENV = Symbol('V1_ENV');
const V1_RUNTIME = Symbol('V1_RUNTIME');

interface V1Runtime {
  pool: Pool;
  games: GameRepository;
  groups: GroupRepository;
}

@Injectable()
class V1RuntimeLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(V1_RUNTIME) private readonly runtime: V1Runtime) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.runtime.pool.end();
  }
}

@Module({
  controllers: [GamesController],
  providers: [
    { provide: V1_ENV, useFactory: (): AppEnv => parseEnv(process.env) },
    {
      provide: V1_RUNTIME,
      inject: [V1_ENV],
      useFactory: (env: AppEnv): V1Runtime => {
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        const database = createDatabase(pool);
        return {
          pool,
          games: new GameRepository(database),
          groups: new GroupRepository(database),
        };
      },
    },
    {
      provide: MINI_APP_INIT_DATA_VERIFIER,
      inject: [V1_ENV],
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
    V1RuntimeLifecycle,
  ],
})
export class V1Module {}
