import { createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  AuthorizationService,
  ConfirmTentative,
  ChangeChargeStatus,
  ConfigureGroup,
  FinalizeSettlement,
  OnboardGroup,
  RegisterGuest,
  RegisterParticipant,
  PreviewSettlement,
  SendPaymentReminders,
  WithdrawRegistration,
  type ConfigurationLinkFactory,
} from '@volley/application';
import { parseEnv, type AppEnv } from '@volley/config';
import {
  createDatabase,
  GuestRegistrationDraftRepository,
  GroupRepository,
  PaymentRepository,
  RegistrationRepository,
} from '@volley/persistence';
import {
  CallbackCodec,
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  GrammyTelegramGateway,
  GuestFlowHandlers,
  GroupOnboardingHandlers,
  PaymentHandlers,
  RegistrationHandlers,
  registerRegistrationHandlers,
  registerTentativeHandlers,
  registerGroupOnboardingHandlers,
  registerPaymentHandlers,
  SignedStartToken,
  TelegramMembershipResolver,
  TentativeHandlers,
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
        const database = createDatabase(pool);
        const groups = new GroupRepository(database);
        const registrations = new RegistrationRepository(database);
        const guestDrafts = new GuestRegistrationDraftRepository(database);
        const payments = new PaymentRepository(database);
        const authorization = new AuthorizationService({
          findMembership: (groupId, userId) =>
            groups.findMembershipByUserId(groupId, userId),
          findMembershipByTelegramUserId: (groupId, telegramUserId) =>
            groups.findMembership(groupId, telegramUserId),
        });
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
          new ConfigureGroup(authorization, groups),
          authorization,
          groups,
          signer,
          telegram,
        );
        const guestHandlers = new GuestFlowHandlers(
          signer,
          guestDrafts,
          registrations,
          new RegisterGuest(registrations),
        );
        registerPaymentHandlers(
          bot,
          new PaymentHandlers(
            registrations,
            new PreviewSettlement(authorization, payments),
            new FinalizeSettlement(authorization, payments),
            new ChangeChargeStatus(authorization, payments),
            new SendPaymentReminders(authorization, payments),
            payments,
            authorization,
          ),
        );
        registerGroupOnboardingHandlers(bot, handlers, guestHandlers);
        registerRegistrationHandlers(
          bot,
          new RegistrationHandlers(
            new CallbackCodec(),
            registrations,
            new RegisterParticipant(
              new TelegramMembershipResolver(telegram, groups),
              registrations,
            ),
            new WithdrawRegistration(registrations),
            {
              create: (gameId, inviterTelegramId): string => {
                const token = signer.sign({
                  purpose: 'add-guest',
                  gameId,
                  inviterTelegramId,
                  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                });
                const username = bot.botInfo.username;
                if (username === undefined) {
                  throw new Error('Telegram bot username is required');
                }
                return `https://t.me/${username}?start=${token}`;
              },
            },
          ),
        );
        registerTentativeHandlers(
          bot,
          new TentativeHandlers(
            {
              resolve: (registrationId, telegramUserId) =>
                registrations.resolveTentativeActor(
                  registrationId,
                  telegramUserId,
                ),
            },
            new ConfirmTentative(registrations),
            new WithdrawRegistration(registrations),
          ),
        );
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
