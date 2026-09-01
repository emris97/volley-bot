import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  ConfigureGroup,
  OnboardGroup,
  type ConfigurationLinkFactory,
} from '@volley/application';
import { parseEnv, type AppEnv } from '@volley/config';
import { createDatabase, GroupRepository } from '@volley/persistence';
import {
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  GrammyTelegramGateway,
  GroupOnboardingHandlers,
  registerGroupOnboardingHandlers,
  SignedStartToken,
  TELEGRAM_UPDATE_HANDLER,
  TELEGRAM_WEBHOOK_SECRET,
  WebhookController,
  type TelegramUpdateHandler,
} from '@volley/telegram';
import { Pool } from 'pg';

const TELEGRAM_ENV = Symbol('TELEGRAM_ENV');
const TELEGRAM_RUNTIME = Symbol('TELEGRAM_RUNTIME');

interface TelegramRuntime {
  bot: TelegramUpdateHandler;
  pool: Pool;
}

@Injectable()
class TelegramRuntimeLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(TELEGRAM_RUNTIME) private readonly runtime: TelegramRuntime,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.pool.end();
  }
}

@Module({
  controllers: [WebhookController],
  providers: [
    {
      provide: TELEGRAM_ENV,
      useFactory: (): AppEnv => parseEnv(process.env),
    },
    {
      provide: TELEGRAM_RUNTIME,
      inject: [TELEGRAM_ENV],
      useFactory: (env: AppEnv): TelegramRuntime => {
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        const groups = new GroupRepository(createDatabase(pool));
        const bot = createTelegramBot(env.BOT_TOKEN);
        const telegram = new GrammyTelegramGateway(bot);
        const signer = new SignedStartToken(
          createHash('sha256')
            .update(`volley:start-token:${env.TELEGRAM_WEBHOOK_SECRET}`)
            .digest('hex'),
        );
        const links: ConfigurationLinkFactory = {
          create: ({ groupId, administratorTelegramId }): string => {
            const token = signer.sign({
              purpose: 'configure-group',
              groupId,
              administratorTelegramId,
              expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            });
            const username = bot.botInfo.username;
            if (username === undefined) {
              throw new Error('Telegram bot username is required');
            }
            return `https://t.me/${username}?start=${token}`;
          },
        };
        const handlers = new GroupOnboardingHandlers(
          new OnboardGroup(telegram, groups, links),
          new ConfigureGroup(groups),
          groups,
          signer,
          telegram,
        );
        registerGroupOnboardingHandlers(bot, handlers);
        return { bot: createLazyTelegramUpdateHandler(bot), pool };
      },
    },
    {
      provide: TELEGRAM_UPDATE_HANDLER,
      inject: [TELEGRAM_RUNTIME],
      useFactory: (runtime: TelegramRuntime): TelegramUpdateHandler =>
        runtime.bot,
    },
    {
      provide: TELEGRAM_WEBHOOK_SECRET,
      inject: [TELEGRAM_ENV],
      useFactory: (env: AppEnv): string => env.TELEGRAM_WEBHOOK_SECRET,
    },
    TelegramRuntimeLifecycle,
  ],
})
export class TelegramModule {}
