import { createHash } from 'node:crypto';
import { Module } from '@nestjs/common';
import {
  AuthorizationService,
  ConfirmAttendance,
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
import type { AppEnv } from '@volley/config';
import {
  type Database,
  AttendanceRepository,
  GuestRegistrationDraftRepository,
  GroupRepository,
  PaymentRepository,
  RegistrationRepository,
} from '@volley/persistence';
import {
  CallbackCodec,
  AttendanceHandlers,
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  GrammyTelegramGateway,
  GuestFlowHandlers,
  GroupOnboardingHandlers,
  PaymentHandlers,
  RegistrationHandlers,
  registerRegistrationHandlers,
  registerAttendanceHandlers,
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
import { APP_ENV, DATABASE } from '../infrastructure/infrastructure.module.js';

const TELEGRAM_RUNTIME = Symbol('TELEGRAM_RUNTIME');

interface TelegramRuntime {
  bot: TelegramUpdateHandler;
}

@Module({
  controllers: [WebhookController],
  providers: [
    {
      provide: TELEGRAM_RUNTIME,
      inject: [APP_ENV, DATABASE],
      useFactory: (env: AppEnv, database: Database): TelegramRuntime => {
        const groups = new GroupRepository(database);
        const registrations = new RegistrationRepository(database);
        const attendance = new AttendanceRepository(database);
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
        registerAttendanceHandlers(
          bot,
          new AttendanceHandlers(
            registrations,
            new ConfirmAttendance(authorization, attendance),
            attendance,
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
        return { bot: createLazyTelegramUpdateHandler(bot) };
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
      inject: [APP_ENV],
      useFactory: (env: AppEnv): string => env.TELEGRAM_WEBHOOK_SECRET,
    },
  ],
})
export class TelegramModule {}
