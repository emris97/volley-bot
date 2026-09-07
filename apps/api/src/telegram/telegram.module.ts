import { createHash } from 'node:crypto';
import { Module } from '@nestjs/common';
import {
  AuthorizationService,
  ChangeChargeStatus,
  ChangeGameState,
  ConfigureGroup,
  ConfirmAttendance,
  ConfirmTentative,
  CreateTemplate,
  DeleteDraftGame,
  FinalizeSettlement,
  ListGames,
  ListTemplates,
  OnboardGroup,
  PreviewSettlement,
  PublishGame,
  RegisterGuest,
  RegisterParticipant,
  ResolveOrganizerContext,
  SendPaymentReminders,
  SetTemplateArchived,
  UpdateGame,
  UpdateTemplate,
  WithdrawRegistration,
  type ConfigurationLinkFactory,
  type OrganizerContext,
} from '@volley/application';
import type { AppEnv } from '@volley/config';
import type { GameTemplateSnapshot } from '@volley/domain';
import {
  AttendanceRepository,
  GameCreationDraftRepository,
  GameRepository,
  GroupRepository,
  GuestRegistrationDraftRepository,
  ManagementRepository,
  OrganizerDirectoryRepository,
  OrganizerTextFlowRepository,
  PaymentRepository,
  RegistrationRepository,
  TemplateRepository,
  TemplateWizardDraftRepository,
  type Database,
} from '@volley/persistence';
import {
  AttendanceHandlers,
  CallbackCodec,
  GameCreationHandlers,
  GameManagementHandlers,
  GrammyTelegramGateway,
  GroupOnboardingHandlers,
  GroupSettingsHandlers,
  GuestFlowHandlers,
  ManagementEntryHandlers,
  OrganizerMenuHandlers,
  PaymentHandlers,
  RegistrationHandlers,
  SignedStartToken,
  TelegramMembershipResolver,
  TemplateWizardHandlers,
  TentativeHandlers,
  TELEGRAM_UPDATE_HANDLER,
  TELEGRAM_WEBHOOK_SECRET,
  WebhookController,
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  registerAttendanceHandlers,
  registerGameCreationHandlers,
  registerGroupOnboardingHandlers,
  registerGroupSettingsHandlers,
  registerManagementEntryHandlers,
  registerOrganizerMenuHandlers,
  registerPaymentHandlers,
  registerPrivateChatLinking,
  registerRegistrationHandlers,
  registerTemplateWizardHandlers,
  registerTentativeHandlers,
  renderOrganizerHelp,
  LiveOrganizerGameActorResolver,
  type TelegramUpdateHandler,
} from '@volley/telegram';
import { APP_ENV, DATABASE } from '../infrastructure/infrastructure.module.js';
import { TelegramCommandMenuService } from './telegram-command-menu.service.js';

const TELEGRAM_RUNTIME = Symbol('TELEGRAM_RUNTIME');

interface TelegramRuntime {
  bot: TelegramUpdateHandler;
  commandMenu: TelegramCommandMenuService;
}

export interface ProductionTelegramHandlers {
  privateDirectory: Parameters<typeof registerPrivateChatLinking>[1];
  payments: PaymentHandlers;
  attendance: AttendanceHandlers;
  templates: TemplateWizardHandlers;
  gameCreation: GameCreationHandlers;
  organizerMenu: OrganizerMenuHandlers;
  groupSettings: GroupSettingsHandlers;
  management: ManagementEntryHandlers;
  onboarding: GroupOnboardingHandlers;
  guests: GuestFlowHandlers;
  registrations: RegistrationHandlers;
  tentative: TentativeHandlers;
}

export const registerProductionTelegramHandlers = (
  bot: Parameters<typeof registerPrivateChatLinking>[0],
  handlers: ProductionTelegramHandlers,
): Parameters<typeof registerPrivateChatLinking>[0] => {
  registerPrivateChatLinking(bot, handlers.privateDirectory);

  registerPaymentHandlers(bot, handlers.payments);
  registerAttendanceHandlers(bot, handlers.attendance);

  registerTemplateWizardHandlers(bot, handlers.templates);
  registerGameCreationHandlers(bot, handlers.gameCreation);

  registerOrganizerMenuHandlers(bot, handlers.organizerMenu);
  registerGroupSettingsHandlers(bot, handlers.groupSettings);
  registerManagementEntryHandlers(
    bot,
    handlers.management,
    handlers.attendance,
    handlers.payments,
  );

  registerGroupOnboardingHandlers(
    bot,
    handlers.onboarding,
    handlers.guests,
    handlers.organizerMenu,
  );

  registerRegistrationHandlers(bot, handlers.registrations);
  registerTentativeHandlers(bot, handlers.tentative);
  return bot;
};

@Module({
  controllers: [WebhookController],
  providers: [
    {
      provide: TELEGRAM_RUNTIME,
      inject: [APP_ENV, DATABASE],
      useFactory: (env: AppEnv, database: Database): TelegramRuntime => {
        const groups = new GroupRepository(database);
        const organizerDirectory = new OrganizerDirectoryRepository(database);
        const templateRepository = new TemplateRepository(database);
        const templateDrafts = new TemplateWizardDraftRepository(database);
        const gameDrafts = new GameCreationDraftRepository(database);
        const games = new GameRepository(database);
        const registrations = new RegistrationRepository(database);
        const attendance = new AttendanceRepository(database);
        const guestDrafts = new GuestRegistrationDraftRepository(database);
        const payments = new PaymentRepository(database);
        const management = new ManagementRepository(database);
        const textFlows = new OrganizerTextFlowRepository(database);

        const authorization = new AuthorizationService({
          findMembership: (groupId, userId) =>
            groups.findMembershipByUserId(groupId, userId),
          findMembershipByTelegramUserId: (groupId, telegramUserId) =>
            groups.findMembership(groupId, telegramUserId),
        });
        const bot = createTelegramBot(env.BOT_TOKEN);
        const telegram = new GrammyTelegramGateway(bot);
        const organizerContext = new ResolveOrganizerContext(
          telegram,
          organizerDirectory,
        );
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

        const configureGroup = new ConfigureGroup(authorization, groups);
        const liveOrganizerGameActor = new LiveOrganizerGameActorResolver(
          telegram,
          management,
        );
        const onboarding = new GroupOnboardingHandlers(
          new OnboardGroup(telegram, groups, links),
          configureGroup,
          authorization,
          groups,
          signer,
          telegram,
        );
        const guests = new GuestFlowHandlers(
          signer,
          guestDrafts,
          registrations,
          new RegisterGuest(registrations),
        );
        const paymentHandlers = new PaymentHandlers(
          liveOrganizerGameActor,
          new PreviewSettlement(authorization, payments),
          new FinalizeSettlement(authorization, payments),
          new ChangeChargeStatus(authorization, payments),
          new SendPaymentReminders(authorization, payments),
          payments,
          authorization,
          textFlows,
        );
        const attendanceHandlers = new AttendanceHandlers(
          liveOrganizerGameActor,
          new ConfirmAttendance(authorization, attendance),
          attendance,
          textFlows,
        );

        const listTemplates = new ListTemplates(templateRepository);
        const createTemplate = new CreateTemplate(
          authorization,
          templateRepository,
        );
        const updateTemplate = new UpdateTemplate(
          authorization,
          templateRepository,
        );
        const setTemplateArchived = new SetTemplateArchived(
          authorization,
          templateRepository,
        );
        const templateServices = {
          findById: (
            groupId: Parameters<TemplateRepository['findById']>[0],
            templateId: Parameters<TemplateRepository['findById']>[1],
          ) => templateRepository.findById(groupId, templateId),
          list: (input: Parameters<ListTemplates['execute']>[0]) =>
            listTemplates.execute(input),
          create: (snapshot: GameTemplateSnapshot, context: OrganizerContext) =>
            createTemplate.execute({
              ...snapshot,
              groupId: context.groupId,
              actorUserId: context.userId,
            }),
          update: (input: Parameters<UpdateTemplate['execute']>[0]) =>
            updateTemplate.execute(input),
          setArchived: (input: Parameters<SetTemplateArchived['execute']>[0]) =>
            setTemplateArchived.execute(input),
        };
        const publishGame = new PublishGame(authorization, groups, games);
        const gameCreation = new GameCreationHandlers({
          organizerContext,
          drafts: gameDrafts,
          templates: {
            list: (input) => listTemplates.execute(input),
            findById: (groupId, templateId) =>
              templateRepository.findById(groupId, templateId),
          },
          publishGame,
          textFlows,
          defaults: {
            load: async (groupId) =>
              (await groups.getOnboardingSnapshot(groupId))?.settings ?? null,
          },
        });
        const templateHandlers = new TemplateWizardHandlers(
          organizerContext,
          templateDrafts,
          templateServices,
          (telegramUserId, templateId) =>
            gameCreation.startFromTemplate(telegramUserId, templateId),
          textFlows,
        );
        const gameManagement = new GameManagementHandlers(
          new ChangeGameState(authorization, games),
          new UpdateGame(authorization, registrations),
          new DeleteDraftGame(authorization, games),
          new ListGames(authorization, games),
          organizerContext,
        );
        const settings = new GroupSettingsHandlers(
          organizerContext,
          groups,
          configureGroup,
        );
        const organizerMenu = new OrganizerMenuHandlers(organizerContext, {
          openGames: (telegramUserId, kind) =>
            gameManagement.openGames(telegramUserId, kind),
          openNewGame: (telegramUserId) => gameCreation.start(telegramUserId),
          openTemplates: (telegramUserId) =>
            templateHandlers.open(telegramUserId),
          openSettings: (telegramUserId) => settings.open(telegramUserId),
          openHelp: async () => renderOrganizerHelp(),
        });
        const managementHandlers = new ManagementEntryHandlers(
          management,
          authorization,
          telegram,
          gameManagement,
          textFlows,
        );
        const registrationHandlers = new RegistrationHandlers(
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
        );
        const tentative = new TentativeHandlers(
          {
            resolve: (registrationId, telegramUserId) =>
              registrations.resolveTentativeActor(
                registrationId,
                telegramUserId,
              ),
          },
          new ConfirmTentative(registrations),
          new WithdrawRegistration(registrations),
        );

        registerProductionTelegramHandlers(bot, {
          privateDirectory: management,
          payments: paymentHandlers,
          attendance: attendanceHandlers,
          templates: templateHandlers,
          gameCreation,
          organizerMenu,
          groupSettings: settings,
          management: managementHandlers,
          onboarding,
          guests,
          registrations: registrationHandlers,
          tentative,
        });
        return {
          bot: createLazyTelegramUpdateHandler(bot),
          commandMenu: new TelegramCommandMenuService(bot.api),
        };
      },
    },
    {
      provide: TelegramCommandMenuService,
      inject: [TELEGRAM_RUNTIME],
      useFactory: (runtime: TelegramRuntime): TelegramCommandMenuService =>
        runtime.commandMenu,
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
