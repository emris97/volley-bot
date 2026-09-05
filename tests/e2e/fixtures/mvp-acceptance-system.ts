import { createHmac } from 'node:crypto';
import { createRequire as makeRequire } from 'node:module';
import { Test } from '@nestjs/testing';
import {
  AuthorizationService,
  ChangeChargeStatus,
  ChangeGameState,
  ChangeRegistrationOrder,
  ConfigureGroup,
  ConfirmAttendance,
  CreateGame,
  CreateTemplate,
  FinalizeSettlement,
  GetGame,
  OnboardGroup,
  OutboxDispatcher,
  PreviewSettlement,
  ReconcileGameJobs,
  RegisterGuest,
  RegisterParticipant,
  SendPaymentReminders,
  type RequiredJob,
  type TelegramGateway,
  WithdrawRegistration,
  type ConfigurationLinkFactory,
} from '@volley/application';
import {
  asGameId,
  asRegistrationId,
  asTelegramId,
  type AttendanceSnapshot,
  type Game,
  type GameId,
  type GameTemplate,
  type Group,
  type GroupId,
  type RegistrationId,
  type RegistrationState,
  type UserId,
} from '@volley/domain';
import {
  AttendanceRepository,
  createDatabase,
  GameMessageRepository,
  GameRepository,
  GuestRegistrationDraftRepository,
  GroupRepository,
  ManagementRepository,
  NotificationRepository,
  OutboxRepository,
  PaymentRepository,
  PaymentReminderRepository,
  RegistrationRepository,
  ScheduledJobRepository,
  TemplateRepository,
  type Database,
} from '@volley/persistence';
import {
  AttendanceHandlers,
  CallbackCodec,
  createLazyTelegramUpdateHandler,
  createTelegramBot,
  GameMessageUpdater,
  GroupOnboardingHandlers,
  GuestFlowHandlers,
  ManagementEntryHandlers,
  NotificationSender,
  PaymentHandlers,
  PaymentReminderSender,
  RegistrationHandlers,
  registerAttendanceHandlers,
  registerGroupOnboardingHandlers,
  registerManagementEntryHandlers,
  registerPaymentHandlers,
  registerPrivateChatLinking,
  registerRegistrationHandlers,
  renderGameMessage,
  SignedStartToken,
  TelegramMembershipResolver,
  WebhookController,
  type RenderedTelegramMessage,
} from '@volley/telegram';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { AppModule } from '../../../apps/api/src/app.module.js';
import { NotificationConsumer } from '../../../apps/worker/src/notifications/notification.consumer.js';
import { PaymentReminderConsumer } from '../../../apps/worker/src/payments/payment-reminder.consumer.js';
import { BullMqJobPublisher } from '../../../apps/worker/src/outbox/outbox.consumer.js';
import {
  BullMqDelayedJobScheduler,
  GameSchedulerConsumer,
} from '../../../apps/worker/src/scheduling/game-scheduler.consumer.js';
import {
  OutboxEventRouter,
  WaitlistPromotionConsumer,
} from '../../../apps/worker/src/telegram/game-message.consumer.js';
import { applyTestMigrations } from '../../../packages/persistence/src/migrations/migration-test-helper.js';
import { FakeTelegramGateway } from './telegram-gateway.fake.js';

const persistenceRequire = makeRequire(
  new URL('../../../packages/persistence/package.json', import.meta.url),
);
const workerRequire = makeRequire(
  new URL('../../../apps/worker/package.json', import.meta.url),
);
const apiRequire = makeRequire(
  new URL('../../../apps/api/package.json', import.meta.url),
);

interface PoolLike {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

interface QueueJobLike {
  id?: string;
  name: string;
  data: Record<string, unknown>;
  attemptsMade: number;
}

interface QueueLike {
  close(): Promise<void>;
  count(): Promise<number>;
  getJob(id: string): Promise<QueueJobLike | undefined>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

interface RedisLike {
  flushall(): Promise<string>;
  quit(): Promise<string>;
}

interface HttpResponseLike {
  statusCode: number;
  json(): unknown;
}

interface BotApiCall {
  method: string;
  payload: Record<string, unknown>;
}

interface ProductionAppLike {
  init(): Promise<void>;
  close(): Promise<void>;
  getHttpAdapter(): {
    getInstance(): {
      ready(): Promise<void>;
      inject(input: {
        method: string;
        url: string;
        headers?: Record<string, string>;
      }): Promise<HttpResponseLike>;
    };
  };
}

const { Pool } = persistenceRequire('pg') as {
  Pool: new (options: { connectionString: string; max?: number }) => PoolLike;
};
const { Queue } = workerRequire('bullmq') as {
  Queue: new (
    name: string,
    options: { connection: { host: string; port: number } },
  ) => QueueLike;
};
const RedisModule = workerRequire('ioredis') as {
  default?: new (url: string, options?: Record<string, unknown>) => RedisLike;
  Redis?: new (url: string, options?: Record<string, unknown>) => RedisLike;
};
const RedisConstructor = RedisModule.default ?? RedisModule.Redis;
if (RedisConstructor === undefined) throw new Error('ioredis export missing');
const { FastifyAdapter } = apiRequire('@nestjs/platform-fastify') as {
  FastifyAdapter: new () => unknown;
};

const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const WEBHOOK_SECRET = 'acceptance-webhook-secret';
const START_TOKEN_SECRET =
  'acceptance-start-token-secret-with-at-least-thirty-two-bytes';
const STARTS_AT = new Date('2026-09-10T16:00:00.000Z');
const BOT_INFO = {
  id: 999,
  is_bot: true,
  first_name: 'Volley',
  username: 'volley_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} as const;

export interface AcceptanceGroup extends Group {
  ownerUserId: UserId;
}

export interface AcceptanceFixture {
  groupId: GroupId;
  organizerUserId: UserId;
  game: Game;
}

interface AcceptanceRegistration {
  registrationId: RegistrationId;
  userId: UserId;
  state: RegistrationState;
}

class CanonicalTelegramGateway {
  private nextMessageId = 1n;
  private readonly gameByMessage = new Map<string, GameId>();
  private readonly textByGame = new Map<GameId, string>();

  public async sendMessage(
    chatId: ReturnType<typeof asTelegramId>,
    message: RenderedTelegramMessage,
  ): Promise<{ messageId: bigint }> {
    const messageId = this.nextMessageId++;
    this.gameByMessage.set(
      `${chatId}:${messageId}`,
      gameIdFromMessage(message),
    );
    this.textByGame.set(gameIdFromMessage(message), message.text);
    return { messageId };
  }

  public async editMessage(
    chatId: ReturnType<typeof asTelegramId>,
    messageId: bigint,
    message: RenderedTelegramMessage,
  ): Promise<void> {
    const gameId = this.gameByMessage.get(`${chatId}:${messageId}`);
    if (gameId !== undefined) this.textByGame.set(gameId, message.text);
  }

  public async pinMessage(): Promise<void> {}

  public record(gameId: GameId, message: RenderedTelegramMessage): void {
    this.textByGame.set(gameId, message.text);
  }

  public text(gameId: GameId): string | undefined {
    return this.textByGame.get(gameId);
  }

  public clear(): void {
    this.nextMessageId = 1n;
    this.gameByMessage.clear();
    this.textByGame.clear();
  }
}

const gameIdFromMessage = (message: RenderedTelegramMessage): GameId => {
  const callbacks = message.keyboard
    .flat()
    .map((button) => button.callbackData);
  const match = callbacks
    .join(':')
    .match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  if (match === null) throw new Error('Rendered game message has no game id');
  return asGameId(match[0]);
};

export class MvpAcceptanceSystem {
  public readonly telegram = new FakeTelegramGateway();
  private readonly registrationResponses: string[] = [];
  private readonly botApiCalls: BotApiCall[] = [];
  private readonly updateIdsByIdempotencyKey = new Map<string, number>();

  private readonly canonicalTelegram = new CanonicalTelegramGateway();
  private readonly groups: GroupRepository;
  private readonly games: GameRepository;
  private readonly templates: TemplateRepository;
  private readonly registrations: RegistrationRepository;
  private readonly attendance: AttendanceRepository;
  private readonly payments: PaymentRepository;
  private readonly notifications: NotificationRepository;
  private readonly authorization: AuthorizationService;
  private readonly createGameUseCase: CreateGame;
  private readonly createTemplateUseCase: CreateTemplate;
  private readonly changeGameState: ChangeGameState;
  private readonly registerParticipant: RegisterParticipant;
  private readonly registerGuestUseCase: RegisterGuest;
  private readonly withdrawRegistration: WithdrawRegistration;
  private readonly changeRegistrationOrder: ChangeRegistrationOrder;
  private readonly messageRepository: GameMessageRepository;
  private readonly reconciler: ReconcileGameJobs;
  private readonly sender: NotificationSender;
  private readonly signer: SignedStartToken;
  private readonly webhook: WebhookController;
  private readonly registrationHandlers: RegistrationHandlers;
  private readonly guestFlowHandlers: GuestFlowHandlers;
  private readonly scheduledNotifications: GameSchedulerConsumer;
  private readonly outboxDispatcher: OutboxDispatcher;
  private readonly outboxRouter: OutboxEventRouter;
  private readonly waitlistPromotions: WaitlistPromotionConsumer;
  private readonly paymentReminderConsumer: PaymentReminderConsumer;
  private apiApp?: ProductionAppLike;
  private previousApiEnv?: NodeJS.ProcessEnv;
  private groupSequence = 20_000;
  private updateSequence = 1;

  private constructor(
    private readonly postgres: StartedTestContainer,
    private readonly redisContainer: StartedTestContainer,
    private readonly pool: PoolLike,
    private readonly database: Database,
    private readonly redis: RedisLike,
    private readonly queue: QueueLike,
    private readonly outboxQueue: QueueLike,
    private readonly canonicalQueue: QueueLike,
    private readonly notificationQueue: QueueLike,
    private readonly paymentReminderQueue: QueueLike,
    private readonly databaseUrl: string,
    private readonly redisUrl: string,
  ) {
    this.groups = new GroupRepository(database);
    this.games = new GameRepository(database);
    this.templates = new TemplateRepository(database);
    this.registrations = new RegistrationRepository(database);
    this.attendance = new AttendanceRepository(database);
    this.payments = new PaymentRepository(database);
    this.notifications = new NotificationRepository(database);
    this.authorization = new AuthorizationService({
      findMembership: (groupId, userId) =>
        this.groups.findMembershipByUserId(groupId, userId),
      findMembershipByTelegramUserId: (groupId, telegramUserId) =>
        this.groups.findMembership(groupId, telegramUserId),
    });
    this.createGameUseCase = new CreateGame(
      this.authorization,
      this.templates,
      this.games,
      this.groups,
    );
    this.createTemplateUseCase = new CreateTemplate(
      this.authorization,
      this.templates,
    );
    this.changeGameState = new ChangeGameState(this.authorization, this.games);
    this.registerParticipant = new RegisterParticipant(
      { priorityFor: async () => 1 },
      this.registrations,
    );
    this.registerGuestUseCase = new RegisterGuest(this.registrations);
    this.withdrawRegistration = new WithdrawRegistration(this.registrations);
    this.changeRegistrationOrder = new ChangeRegistrationOrder(
      this.authorization,
      this.registrations,
    );
    this.messageRepository = new GameMessageRepository(database, pool as never);
    this.reconciler = new ReconcileGameJobs(
      new ScheduledJobRepository(database),
      new BullMqDelayedJobScheduler(queue as never),
    );
    this.sender = new NotificationSender(this.telegram, this.notifications);
    this.signer = new SignedStartToken(START_TOKEN_SECRET);
    const telegramGateway: TelegramGateway = {
      getChatMember: (chatId, telegramUserId) =>
        this.telegram.getChatMember(chatId, telegramUserId),
      sendMessage: async (chatId, message, options) => {
        const messageId = BigInt(this.updateSequence);
        this.botApiCalls.push({
          method: 'sendMessage',
          payload: onboardingMessagePayload(chatId, message, options),
        });
        if (chatId.startsWith('-')) {
          await this.telegram.sendGroupMessage(chatId, message);
        } else {
          await this.telegram.sendPrivate(
            chatId,
            message,
            options?.keyboard?.flat() ?? [],
          );
        }
        return { messageId };
      },
      editMessage: async (chatId, messageId, message, options) => {
        this.botApiCalls.push({
          method: 'editMessageText',
          payload: {
            ...onboardingMessagePayload(chatId, message, options),
            message_id: Number(messageId),
          },
        });
        await this.telegram.sendPrivate(
          chatId,
          message,
          options?.keyboard?.flat() ?? [],
        );
      },
    };
    const links: ConfigurationLinkFactory = {
      create: ({ groupId, administratorTelegramId }) => {
        const token = this.signer.sign({
          purpose: 'configure-group',
          groupId,
          administratorTelegramId,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
        return `https://t.me/${BOT_INFO.username}?start=${token}`;
      },
    };
    const onboardingHandlers = new GroupOnboardingHandlers(
      new OnboardGroup(telegramGateway, this.groups, links),
      new ConfigureGroup(this.authorization, this.groups),
      this.authorization,
      this.groups,
      this.signer,
      telegramGateway,
    );
    this.registrationHandlers = new RegistrationHandlers(
      new CallbackCodec(),
      this.registrations,
      new RegisterParticipant(
        new TelegramMembershipResolver(telegramGateway, this.groups),
        this.registrations,
      ),
      this.withdrawRegistration,
    );
    this.guestFlowHandlers = new GuestFlowHandlers(
      this.signer,
      new GuestRegistrationDraftRepository(database),
      this.registrations,
      this.registerGuestUseCase,
    );
    const paymentHandlers = new PaymentHandlers(
      this.registrations,
      new PreviewSettlement(this.authorization, this.payments),
      new FinalizeSettlement(this.authorization, this.payments),
      new ChangeChargeStatus(this.authorization, this.payments),
      new SendPaymentReminders(this.authorization, this.payments),
      this.payments,
      this.authorization,
    );
    const attendanceHandlers = new AttendanceHandlers(
      this.registrations,
      new ConfirmAttendance(this.authorization, this.attendance),
      this.attendance,
    );
    const management = new ManagementRepository(database);
    const bot = createTelegramBot(BOT_TOKEN, BOT_INFO as never);
    bot.api.config.use(async (_previous, method, payload) => {
      const record = { method, payload: payload as Record<string, unknown> };
      this.botApiCalls.push(record);
      if (method === 'answerCallbackQuery') {
        return { ok: true, result: true } as never;
      }
      const chatId = asTelegramId(String(record.payload.chat_id ?? '0'));
      const text = String(record.payload.text ?? '');
      const buttons = botApiButtons(record);
      if (chatId.startsWith('-')) {
        await this.telegram.sendGroupMessage(chatId, text);
      } else {
        await this.telegram.sendPrivate(
          chatId,
          text,
          buttons.map((button) => ({
            text: button.text,
            callbackData: button.callback_data,
          })),
        );
      }
      return {
        ok: true,
        result: {
          message_id: this.botApiCalls.length,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: Number(chatId), type: 'private' },
          text,
        },
      } as never;
    });
    registerPrivateChatLinking(bot, management);
    registerPaymentHandlers(bot, paymentHandlers);
    registerAttendanceHandlers(bot, attendanceHandlers);
    registerManagementEntryHandlers(
      bot,
      new ManagementEntryHandlers(management, this.authorization),
      attendanceHandlers,
      paymentHandlers,
    );
    registerGroupOnboardingHandlers(
      bot,
      onboardingHandlers,
      this.guestFlowHandlers,
    );
    registerRegistrationHandlers(bot, this.registrationHandlers);
    this.webhook = new WebhookController(
      createLazyTelegramUpdateHandler(bot),
      WEBHOOK_SECRET,
    );
    const notificationConsumer = new NotificationConsumer(
      this.notifications,
      this.sender,
      this.registrations,
    );
    this.scheduledNotifications = new GameSchedulerConsumer(this.games, (job) =>
      notificationConsumer.process(job),
    );
    this.outboxDispatcher = new OutboxDispatcher(
      new OutboxRepository(database),
      new BullMqJobPublisher(outboxQueue as never),
    );
    this.outboxRouter = new OutboxEventRouter(
      canonicalQueue as never,
      notificationQueue as never,
      paymentReminderQueue as never,
    );
    this.waitlistPromotions = new WaitlistPromotionConsumer(
      notificationConsumer,
    );
    this.paymentReminderConsumer = new PaymentReminderConsumer(
      new PaymentReminderRepository(database),
      new PaymentReminderSender({
        sendPrivate: (telegramUserId, text) =>
          this.telegram.sendPrivate(telegramUserId, text, []),
      }),
    );
  }

  public static async start(): Promise<MvpAcceptanceSystem> {
    const [postgres, redisContainer] = await Promise.all([
      new GenericContainer('postgres:16-alpine')
        .withEnvironment({
          POSTGRES_DB: 'volley',
          POSTGRES_PASSWORD: 'postgres',
          POSTGRES_USER: 'postgres',
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2,
          ),
        )
        .start(),
      new GenericContainer('redis:8-alpine')
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start(),
    ]);
    const databaseUrl = `postgresql://postgres:postgres@${postgres.getHost()}:${postgres.getMappedPort(5432)}/volley`;
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    await applyTestMigrations(pool as never);
    const database = createDatabase(pool as never);
    const redis = new RedisConstructor(redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    const queueBase = `mvp-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const connection = {
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(6379),
    };
    const queue = new Queue(`${queueBase}-scheduler`, { connection });
    const outboxQueue = new Queue(`${queueBase}-outbox`, { connection });
    const canonicalQueue = new Queue(`${queueBase}-canonical`, { connection });
    const notificationQueue = new Queue(`${queueBase}-notifications`, {
      connection,
    });
    const paymentReminderQueue = new Queue(`${queueBase}-payment-reminders`, {
      connection,
    });
    return new MvpAcceptanceSystem(
      postgres,
      redisContainer,
      pool,
      database,
      redis,
      queue,
      outboxQueue,
      canonicalQueue,
      notificationQueue,
      paymentReminderQueue,
      databaseUrl,
      redisUrl,
    );
  }

  public async reset(): Promise<void> {
    await this.closeApi();
    await this.redis.flushall();
    await this.pool.query('TRUNCATE groups, users CASCADE');
    this.telegram.clear();
    this.registrationResponses.length = 0;
    this.botApiCalls.length = 0;
    this.updateIdsByIdempotencyKey.clear();
    this.updateSequence = 1;
    this.canonicalTelegram.clear();
  }

  public async stop(): Promise<void> {
    await this.closeApi();
    await Promise.allSettled([
      this.queue.close(),
      this.outboxQueue.close(),
      this.canonicalQueue.close(),
      this.notificationQueue.close(),
      this.paymentReminderQueue.close(),
      this.redis.quit(),
      this.pool.end(),
    ]);
    await Promise.allSettled([
      this.postgres.stop(),
      this.redisContainer.stop(),
    ]);
  }

  public async onboardAndConfigureGroup(input: {
    telegramChatId: string;
    administratorTelegramId: string;
    timeZone: 'Europe/Astrakhan';
  }): Promise<AcceptanceGroup> {
    await this.webhook.handle(
      WEBHOOK_SECRET,
      membershipUpdate(
        this.nextUpdateId(),
        input.telegramChatId,
        input.administratorTelegramId,
      ) as never,
    );
    const started = await this.groups.findByTelegramChatId(
      asTelegramId(input.telegramChatId),
    );
    if (started === null) throw new Error('Onboarded group missing');
    const startLink = this.telegram.groupMessages.at(-1)?.text;
    const token = startLink?.split('?start=')[1];
    if (token === undefined) throw new Error('Onboarding start token missing');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      startUpdate(
        this.nextUpdateId(),
        input.administratorTelegramId,
        token,
      ) as never,
    );
    for (const buttonText of [
      'Астрахань (UTC+4)',
      'Участники группы выше гостей',
      'За 24 часа',
      '1 час',
      'За 2 часа',
      'Точно до копеек',
      'Да',
      '✅ Сохранить настройки',
    ]) {
      const view = this.botApiCalls.findLast(
        ({ method }) =>
          method === 'sendMessage' || method === 'editMessageText',
      );
      if (view === undefined) throw new Error('Onboarding view missing');
      const callback = requiredButton(view, buttonText).callback_data;
      await this.webhook.handle(
        WEBHOOK_SECRET,
        onboardingCallbackUpdate(
          this.nextUpdateId(),
          input.administratorTelegramId,
          callback,
        ) as never,
      );
    }
    const membership = await this.groups.findMembership(
      started.id,
      asTelegramId(input.administratorTelegramId),
    );
    if (membership === null) throw new Error('Owner membership missing');
    const group = await this.groups.findById(started.id);
    if (group === null) throw new Error('Configured group missing');
    return { ...group, ownerUserId: membership.userId };
  }

  public createConfiguredGroup(
    ownerTelegramId: string,
  ): Promise<AcceptanceGroup> {
    this.groupSequence += 1;
    return this.onboardAndConfigureGroup({
      telegramChatId: `-${this.groupSequence}`,
      administratorTelegramId: ownerTelegramId,
      timeZone: 'Europe/Astrakhan',
    });
  }

  public createTemplate(
    groupId: GroupId,
    actorUserId: UserId,
    name: string,
  ): Promise<GameTemplate> {
    return this.createTemplateUseCase.execute({
      groupId,
      actorUserId,
      ...templateSettings(name, 8),
    });
  }

  public createGameFromTemplate(
    groupId: GroupId,
    actorUserId: UserId,
    templateId: NonNullable<GameTemplate['id']>,
  ): Promise<Game> {
    return this.createGameUseCase.execute({
      groupId,
      actorUserId,
      templateId,
      startsAt: STARTS_AT,
      overrides: {},
    });
  }

  public createScratchGame(
    groupId: GroupId,
    actorUserId: UserId,
    input: { name: string; capacity: number },
  ): Promise<Game> {
    return this.createGameUseCase.execute({
      groupId,
      actorUserId,
      startsAt: STARTS_AT,
      overrides: templateSettings(input.name, input.capacity),
    });
  }

  public async publishGame(
    groupId: GroupId,
    gameId: GameId,
    actorUserId: UserId,
  ): Promise<Game> {
    return this.changeGameState.execute({
      groupId,
      gameId,
      actorUserId,
      targetState: 'OPEN',
    });
  }

  public getGame(groupId: GroupId, gameId: GameId): Promise<Game | null> {
    return new GetGame(this.games).getGame(groupId, gameId);
  }

  public async listGames(groupId: GroupId): Promise<Game[]> {
    const result = await this.pool.query<{ id: string }>(
      'SELECT id FROM games WHERE group_id = $1 ORDER BY created_at, id',
      [groupId],
    );
    return (
      await Promise.all(
        result.rows.map(({ id }) => this.games.findById(groupId, asGameId(id))),
      )
    ).filter((game): game is Game => game !== null);
  }

  public async createOpenGame(input: {
    capacity: number;
  }): Promise<AcceptanceFixture> {
    this.groupSequence += 1;
    const ownerTelegramId = String(this.groupSequence + 100_000);
    const group = await this.createConfiguredGroup(ownerTelegramId);
    const draft = await this.createScratchGame(group.id, group.ownerUserId, {
      name: `Acceptance game ${this.groupSequence}`,
      capacity: input.capacity,
    });
    const game = await this.publishGame(group.id, draft.id!, group.ownerUserId);
    return { groupId: group.id, organizerUserId: group.ownerUserId, game };
  }

  public async registerMember(
    fixture: AcceptanceFixture,
    telegramId: string,
    idempotencyKey: string,
  ): Promise<AcceptanceRegistration> {
    const membership = await this.groups.upsertMembership(
      fixture.groupId,
      asTelegramId(telegramId),
      'MEMBER',
    );
    await this.pool.query(
      'UPDATE users SET display_name = $1, dm_available_at = NOW() WHERE id = $2',
      [`Player ${telegramId}`, membership.userId],
    );
    return this.registerViaCallback(
      fixture,
      telegramId,
      membership.userId,
      idempotencyKey,
      'GOING',
    );
  }

  public async registerGuest(
    fixture: AcceptanceFixture,
    inviterUserId: UserId,
    guestDisplayName: string,
    idempotencyKey: string,
  ): Promise<AcceptanceRegistration> {
    const inviterTelegramId = await this.telegramIdForUser(inviterUserId);
    const token = this.signer.sign({
      purpose: 'add-guest',
      gameId: fixture.game.id!,
      inviterTelegramId,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    await this.guestFlowHandlers.handleStart({
      telegramUserId: inviterTelegramId,
      token,
    });
    const updateId = this.updateIdFor(idempotencyKey);
    await this.guestFlowHandlers.handleName({
      telegramUserId: inviterTelegramId,
      text: guestDisplayName,
      updateId,
    });
    const result = await this.pool.query<{
      id: string;
      state: RegistrationState;
    }>(
      `SELECT id, state
       FROM registrations
       WHERE idempotency_key = $1`,
      [`guest-name:${updateId}`],
    );
    const registration = result.rows[0];
    if (registration === undefined)
      throw new Error('Guest registration missing');
    return {
      registrationId: asRegistrationId(registration.id),
      state: registration.state,
      userId: inviterUserId,
    };
  }

  public async registerTentative(
    fixture: AcceptanceFixture,
    telegramId: string,
    idempotencyKey: string,
  ): Promise<AcceptanceRegistration> {
    const membership = await this.groups.upsertMembership(
      fixture.groupId,
      asTelegramId(telegramId),
      'MEMBER',
    );
    await this.pool.query(
      'UPDATE users SET display_name = $1, dm_available_at = NOW() WHERE id = $2',
      [`Player ${telegramId}`, membership.userId],
    );
    return this.registerViaCallback(
      fixture,
      telegramId,
      membership.userId,
      idempotencyKey,
      'TENTATIVE',
    );
  }

  public async withdraw(
    fixture: AcceptanceFixture,
    registrationId: RegistrationId,
    actorUserId: UserId,
  ): Promise<string> {
    const actorTelegramId = await this.telegramIdForUser(actorUserId);
    const actor = await this.registrations.resolve(
      fixture.game.id!,
      actorTelegramId,
    );
    if (actor.activeRegistrationId !== registrationId) {
      throw new Error('Withdrawal registration does not belong to actor');
    }
    const response = await this.registrationHandlers.handleCallback({
      telegramUserId: actorTelegramId,
      updateId: this.nextUpdateId(),
      data: new CallbackCodec().withdraw(fixture.game.id!),
    });
    this.registrationResponses.push(response);
    return response;
  }

  public async registrationState(
    registrationId: RegistrationId,
  ): Promise<RegistrationState> {
    const result = await this.pool.query<{ state: RegistrationState }>(
      'SELECT state FROM registrations WHERE id = $1',
      [registrationId],
    );
    if (result.rows[0] === undefined) throw new Error('Registration missing');
    return result.rows[0].state;
  }

  public handledRegistrationResponses(): readonly string[] {
    return this.registrationResponses;
  }

  public async notificationWasDelivered(
    deterministicJobId: string,
    registrationId: RegistrationId,
  ): Promise<boolean> {
    const result = await this.pool.query<{ delivered: boolean }>(
      `SELECT delivered_at IS NOT NULL AS delivered
       FROM notification_deliveries
       WHERE deterministic_job_id = $1 AND registration_id = $2`,
      [deterministicJobId, registrationId],
    );
    return result.rows[0]?.delivered ?? false;
  }

  public async waitlistPromotionReachedDelivery(
    registrationId: RegistrationId,
  ): Promise<boolean> {
    const result = await this.pool.query<{ delivered: boolean }>(
      `SELECT delivery.delivered_at IS NOT NULL AS delivered
       FROM notification_deliveries AS delivery
       JOIN outbox_events AS event
         ON delivery.deterministic_job_id = 'outbox:' || event.id::text || ':notification'
       WHERE event.event_type = 'WAITLIST_PROMOTED'
         AND event.payload ->> 'registrationId' = $1
         AND event.published_at IS NOT NULL`,
      [registrationId],
    );
    return result.rows[0]?.delivered ?? false;
  }

  public async attendanceSnapshotCount(gameId: GameId): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM attendance_snapshots WHERE game_id = $1',
      [gameId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async registrationCounts(gameId: GameId): Promise<{
    roster: number;
    waitlist: number;
    tentative: number;
  }> {
    const result = await this.pool.query<{
      state: RegistrationState;
      count: string;
    }>(
      `SELECT state, count(*)::text AS count
       FROM registrations
       WHERE game_id = $1 AND state <> 'CANCELLED'
       GROUP BY state`,
      [gameId],
    );
    const counts = new Map(
      result.rows.map((row) => [row.state, Number(row.count)]),
    );
    return {
      roster: counts.get('ROSTERED') ?? 0,
      waitlist: counts.get('WAITLISTED') ?? 0,
      tentative: counts.get('TENTATIVE') ?? 0,
    };
  }

  public overrideOrder(
    fixture: AcceptanceFixture,
    registrationId: RegistrationId,
    actorUserId: UserId,
    manualRank: number,
  ) {
    return this.changeRegistrationOrder.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      registrationId,
      actorUserId,
      manualRank,
      reason: 'Acceptance administrator override',
    });
  }

  public async auditEventTypes(groupId: GroupId): Promise<string[]> {
    const result = await this.pool.query<{ event_type: string }>(
      'SELECT event_type FROM audit_events WHERE group_id = $1 ORDER BY created_at, id',
      [groupId],
    );
    return result.rows.map((row) => row.event_type);
  }

  public async scheduleAndDeliverTentativePrompt(
    fixture: AcceptanceFixture,
    registration: AcceptanceRegistration,
  ): Promise<void> {
    if (
      (await this.registrationState(registration.registrationId)) !==
      'TENTATIVE'
    ) {
      throw new Error('Tentative recipient is not active');
    }
    await this.reconcileGameJobs(fixture);
    const job = await this.requiredScheduledJob(
      `REQUEST_TENTATIVE_CONFIRMATION:${fixture.game.id}:${fixture.game.scheduleRevision}`,
    );
    await this.scheduledNotifications.process(job);
  }

  public async expireTentative(
    fixture: AcceptanceFixture,
    registrationId: RegistrationId,
  ): Promise<void> {
    const job = await this.requiredScheduledJob(
      `EXPIRE_TENTATIVE:${fixture.game.id}:${fixture.game.scheduleRevision}`,
    );
    await this.scheduledNotifications.process(job);
    if ((await this.registrationState(registrationId)) !== 'CANCELLED') {
      throw new Error('Scheduled tentative expiry did not cancel registration');
    }
  }

  public async deliverWaitlistPromotion(
    registrationId: RegistrationId,
  ): Promise<void> {
    const eventResult = await this.pool.query<{ id: string }>(
      `SELECT id
       FROM outbox_events
       WHERE event_type = 'WAITLIST_PROMOTED'
         AND payload ->> 'registrationId' = $1
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
      [registrationId],
    );
    const eventId = eventResult.rows[0]?.id;
    if (eventId === undefined)
      throw new Error('Promotion outbox event missing');
    await this.outboxDispatcher.dispatchOnce();
    const parentJobId = `outbox:${eventId}:event`;
    const parentJob = await this.outboxQueue.getJob(parentJobId);
    if (parentJob === undefined)
      throw new Error('Promotion router job missing');
    await this.outboxRouter.process(
      parentJob.name,
      parentJob.data,
      parentJobId,
      parentJob.attemptsMade,
    );
    const notificationJobId = `outbox:${eventId}:notification`;
    const notificationJob =
      await this.notificationQueue.getJob(notificationJobId);
    if (notificationJob === undefined) {
      throw new Error('Promotion notification job missing');
    }
    await this.waitlistPromotions.process(
      notificationJob.data,
      notificationJobId,
      notificationJob.attemptsMade,
    );
  }

  public createCanonicalMessageUpdater(): GameMessageUpdater {
    const updater = new GameMessageUpdater(
      this.messageRepository,
      this.canonicalTelegram,
    );
    return updater;
  }

  public canonicalMessageText(gameId: GameId): string | undefined {
    return this.canonicalTelegram.text(gameId);
  }

  public async renderAuthoritativeGameMessage(
    groupId: GroupId,
    gameId: GameId,
  ): Promise<string> {
    const view = await this.messageRepository.load(groupId, gameId);
    if (view === null) throw new Error('Game message view missing');
    const rendered = renderGameMessage(view);
    this.canonicalTelegram.record(gameId, rendered);
    return rendered.text;
  }

  public async createCompletedGameWithRoster(
    organizerTelegramId: string,
  ): Promise<AcceptanceFixture> {
    const group = await this.createConfiguredGroup(organizerTelegramId);
    const draft = await this.createScratchGame(group.id, group.ownerUserId, {
      name: 'Completed acceptance game',
      capacity: 2,
    });
    let game = await this.publishGame(group.id, draft.id!, group.ownerUserId);
    await this.registerParticipant.execute({
      groupId: group.id,
      gameId: game.id!,
      userId: group.ownerUserId,
      intent: 'CONFIRMED',
      idempotencyKey: `completed:${game.id}`,
    });
    game = await this.changeGameState.execute({
      groupId: group.id,
      gameId: game.id!,
      actorUserId: group.ownerUserId,
      targetState: 'CLOSED',
    });
    game = await this.changeGameState.execute({
      groupId: group.id,
      gameId: game.id!,
      actorUserId: group.ownerUserId,
      targetState: 'COMPLETED',
    });
    return { groupId: group.id, organizerUserId: group.ownerUserId, game };
  }

  public async confirmAttendanceWithManualParticipant(
    fixture: AcceptanceFixture,
    displayName: string,
  ): Promise<AttendanceSnapshot> {
    const organizerTelegramId = await this.telegramIdForUser(
      fixture.organizerUserId,
    );
    const group = await this.groups.findById(fixture.groupId);
    if (group === null) throw new Error('Acceptance group missing');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId: organizerTelegramId,
        chatId: group.telegramChatId,
        chatType: 'supergroup',
        data: new CallbackCodec().encode({
          version: 1,
          action: 'MANAGE',
          gameId: fixture.game.id!,
        }),
      }) as never,
    );
    const menu = this.requiredBotCall('sendMessage', 'Управление игрой');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId: organizerTelegramId,
        chatId: organizerTelegramId,
        chatType: 'private',
        data: requiredButton(menu, 'Посещаемость').callback_data,
      }) as never,
    );
    const preview = this.requiredBotCall(
      'editMessageText',
      'attendance:preview:',
    );
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId: organizerTelegramId,
        chatId: organizerTelegramId,
        chatType: 'private',
        data: requiredButton(preview, 'Добавить участника').callback_data,
      }) as never,
    );
    const prompt = this.requiredBotCall('sendMessage', 'Введите имя участника');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      privateTextUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId: organizerTelegramId,
        text: displayName,
        replyToText: String(prompt.payload.text),
      }) as never,
    );
    const withManual = this.requiredBotCall(
      'sendMessage',
      'attendance:preview:',
    );
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId: organizerTelegramId,
        chatId: organizerTelegramId,
        chatType: 'private',
        data: requiredButton(withManual, 'Confirm attendance').callback_data,
      }) as never,
    );
    const stored = await this.pool.query<{ id: string }>(
      `SELECT id FROM attendance_snapshots
       WHERE group_id = $1 AND game_id = $2 AND finalized = TRUE
       ORDER BY revision DESC LIMIT 1`,
      [fixture.groupId, fixture.game.id!],
    );
    const snapshotId = stored.rows[0]?.id;
    if (snapshotId === undefined)
      throw new Error('Finalized attendance missing');
    const finalized = await this.attendance.findSnapshot(
      fixture.groupId,
      snapshotId as never,
    );
    if (finalized === null) throw new Error('Finalized attendance missing');
    return finalized;
  }

  public async finalizeSettlement(
    fixture: AcceptanceFixture,
    _attendanceRevision: number,
    totalAmount: string,
    roundingMode: 'EXACT',
  ) {
    if (roundingMode !== 'EXACT')
      throw new Error('Unsupported acceptance mode');
    const telegramUserId = await this.telegramIdForUser(
      fixture.organizerUserId,
    );
    await this.webhook.handle(
      WEBHOOK_SECRET,
      privateCommandUpdate(
        this.nextUpdateId(),
        telegramUserId,
        'manage',
        fixture.game.id!,
      ) as never,
    );
    const menu = this.requiredBotCall('sendMessage', 'Управление игрой');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId,
        chatId: telegramUserId,
        chatType: 'private',
        data: requiredButton(menu, 'Расчёт оплат').callback_data,
      }) as never,
    );
    await this.webhook.handle(
      WEBHOOK_SECRET,
      privateTextUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId,
        text: totalAmount,
      }) as never,
    );
    const preview = this.requiredBotCall('sendMessage', 'Предпросмотр:');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId,
        chatId: telegramUserId,
        chatType: 'private',
        data: requiredButton(preview, 'Подтвердить').callback_data,
      }) as never,
    );
    const settlement = await this.payments.findActiveSettlement(
      fixture.groupId,
      fixture.game.id!,
    );
    if (settlement === null) throw new Error('Finalized settlement missing');
    return settlement;
  }

  public async markChargePaid(fixture: AcceptanceFixture, chargeId: string) {
    const telegramUserId = await this.telegramIdForUser(
      fixture.organizerUserId,
    );
    const view = this.requiredBotCall('editMessageText', 'Расчёт #');
    const callback = botApiButtons(view).find(
      (button) =>
        button.text === 'Оплачено' &&
        button.callback_data.endsWith(compactUuid(chargeId)),
    );
    if (callback === undefined)
      throw new Error('Payment status button missing');
    await this.webhook.handle(
      WEBHOOK_SECRET,
      gameCallbackUpdate({
        updateId: this.nextUpdateId(),
        telegramUserId,
        chatId: telegramUserId,
        chatType: 'private',
        data: callback.callback_data,
      }) as never,
    );
    const settlement = await this.payments.findActiveSettlement(
      fixture.groupId,
      fixture.game.id!,
    );
    const charge = settlement?.charges.find(
      (candidate) => candidate.id === chargeId,
    );
    if (charge === undefined) throw new Error('Updated charge missing');
    return charge;
  }

  public async requestAndRecoverPaymentReminder(
    fixture: AcceptanceFixture,
    chargeId: string,
    idempotencyKey: string,
  ): Promise<{
    outboxIntents: number;
    privateDeliveries: number;
    groupFallbacks: number;
  }> {
    const telegramUserId = await this.telegramIdForUser(
      fixture.organizerUserId,
    );
    const view = this.requiredBotCall('editMessageText', 'Расчёт #');
    const reminder = botApiButtons(view).find(
      (button) =>
        button.text === 'Напомнить' &&
        button.callback_data.endsWith(compactUuid(chargeId)),
    );
    if (reminder === undefined)
      throw new Error('Payment reminder button missing');
    const updateId = this.updateIdFor(idempotencyKey);
    const update = gameCallbackUpdate({
      updateId,
      telegramUserId,
      chatId: telegramUserId,
      chatType: 'private',
      data: reminder.callback_data,
    });
    await this.webhook.handle(WEBHOOK_SECRET, update as never);
    await this.webhook.handle(WEBHOOK_SECRET, update as never);

    const eventRows = await this.pool.query<{ id: string }>(
      `SELECT id FROM outbox_events
       WHERE event_type = 'PAYMENT_REMINDER_REQUESTED' AND aggregate_id = $1`,
      [chargeId],
    );
    const eventId = eventRows.rows[0]?.id;
    if (eventId === undefined)
      throw new Error('Payment reminder outbox missing');
    await this.outboxDispatcher.dispatchOnce();
    await this.flushRedis();

    const recovery = (
      await new OutboxRepository(this.database).listRecoveryBatch(1_000)
    ).find((event) => event.id === eventId);
    if (recovery === undefined) {
      throw new Error('Payment reminder recovery event missing');
    }
    await new BullMqJobPublisher(this.outboxQueue as never).publish({
      id: `outbox:${recovery.id}`,
      type: recovery.type,
      payload: {
        ...recovery.payload,
        groupId: recovery.groupId,
        aggregateType: recovery.aggregateType,
        aggregateId: recovery.aggregateId,
      },
      occurredAt: recovery.occurredAt,
    });
    const parentJobId = `outbox:${eventId}:event`;
    const parentJob = await this.outboxQueue.getJob(parentJobId);
    if (parentJob === undefined)
      throw new Error('Recovered reminder job missing');
    await this.outboxRouter.process(
      parentJob.name,
      parentJob.data,
      parentJobId,
      parentJob.attemptsMade,
    );
    const childJobId = `outbox:${eventId}:payment-reminder`;
    const child = await this.paymentReminderQueue.getJob(childJobId);
    if (child === undefined)
      throw new Error('Payment reminder child job missing');
    const groupMessagesBefore = this.telegram.groupMessages.length;
    const privateMessagesBefore =
      this.telegram.privateMessagesFor(telegramUserId).length;
    await this.paymentReminderConsumer.process(child.data, childJobId);
    await this.paymentReminderConsumer.process(child.data, childJobId);
    return {
      outboxIntents: eventRows.rows.length,
      privateDeliveries:
        this.telegram.privateMessagesFor(telegramUserId).length -
        privateMessagesBefore,
      groupFallbacks: this.telegram.groupMessages.length - groupMessagesBefore,
    };
  }

  public async replayDuplicatePaymentUpdateAcrossRedisLoss(
    fixture: AcceptanceFixture,
    chargeId: string,
    idempotencyKey: string,
  ): Promise<{ before: unknown; after: unknown }> {
    const telegramUserId = await this.telegramIdForUser(
      fixture.organizerUserId,
    );
    const view = this.requiredBotCall('editMessageText', 'Расчёт #');
    const paid = botApiButtons(view).find(
      (button) =>
        button.text === 'Оплачено' &&
        button.callback_data.endsWith(compactUuid(chargeId)),
    );
    if (paid === undefined) throw new Error('Payment status button missing');
    const update = gameCallbackUpdate({
      updateId: this.updateIdFor(idempotencyKey),
      telegramUserId,
      chatId: telegramUserId,
      chatType: 'private',
      data: paid.callback_data,
    });
    await this.webhook.handle(WEBHOOK_SECRET, update as never);
    const before = await this.authoritativePaymentState(fixture.game.id!);
    await this.flushRedis();
    await this.webhook.handle(WEBHOOK_SECRET, update as never);
    const after = await this.authoritativePaymentState(fixture.game.id!);
    return { before, after };
  }

  public async reconcileGameJobs(fixture: AcceptanceFixture): Promise<void> {
    const game = await this.games.findById(fixture.groupId, fixture.game.id!);
    if (game === null) throw new Error('Game missing for reconciliation');
    const candidates = await this.registrations.listCandidates(
      fixture.groupId,
      fixture.game.id!,
    );
    await this.reconciler.execute(game, candidates);
  }

  public flushRedis(): Promise<string> {
    return this.redis.flushall();
  }

  public async redisJobCount(): Promise<number> {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    );
    return Object.values(counts).reduce((sum, count) => sum + count, 0);
  }

  public async getGameThroughProductionApi(
    fixture: AcceptanceFixture,
    telegramId: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    await this.groups.upsertMembership(
      fixture.groupId,
      asTelegramId(telegramId),
      'MEMBER',
    );
    await this.ensureApi();
    const response = await this.injectApi(
      fixture.groupId,
      fixture.game.id!,
      telegramId,
    );
    return {
      statusCode: response.statusCode,
      body: response.json() as Record<string, unknown>,
    };
  }

  public async getForeignGameThroughProductionApi(
    fixture: AcceptanceFixture,
    telegramId: string,
  ): Promise<number> {
    const otherGroup = await this.createConfiguredGroup(telegramId);
    await this.ensureApi();
    return (await this.injectApi(otherGroup.id, fixture.game.id!, telegramId))
      .statusCode;
  }

  private async registerViaCallback(
    fixture: AcceptanceFixture,
    telegramId: string,
    userId: UserId,
    idempotencyKey: string,
    action: 'GOING' | 'TENTATIVE',
  ): Promise<AcceptanceRegistration> {
    const codec = new CallbackCodec();
    const response = await this.registrationHandlers.handleCallback({
      telegramUserId: asTelegramId(telegramId),
      updateId: this.updateIdFor(idempotencyKey),
      data:
        action === 'GOING'
          ? codec.going(fixture.game.id!)
          : codec.tentative(fixture.game.id!),
    });
    this.registrationResponses.push(response);
    const actor = await this.registrations.resolve(
      fixture.game.id!,
      asTelegramId(telegramId),
    );
    if (actor.activeRegistrationId === null) {
      throw new Error('Registration handler did not persist an active record');
    }
    return {
      registrationId: actor.activeRegistrationId,
      state: await this.registrationState(actor.activeRegistrationId),
      userId,
    };
  }

  private async telegramIdForUser(userId: UserId) {
    const result = await this.pool.query<{ telegram_user_id: string }>(
      `SELECT telegram_user_id::text AS telegram_user_id
       FROM users
       WHERE id = $1`,
      [userId],
    );
    const telegramId = result.rows[0]?.telegram_user_id;
    if (telegramId === undefined) throw new Error('Telegram identity missing');
    return asTelegramId(telegramId);
  }

  private async requiredScheduledJob(id: string): Promise<RequiredJob> {
    const queued = await this.queue.getJob(id);
    if (queued === undefined) throw new Error(`Scheduled job ${id} missing`);
    return {
      ...queued.data,
      runAt: new Date(String(queued.data.runAt)),
    } as unknown as RequiredJob;
  }

  private requiredBotCall(method: string, text: string): BotApiCall {
    const call = this.botApiCalls.findLast(
      (candidate) =>
        candidate.method === method &&
        String(candidate.payload.text ?? '').includes(text),
    );
    if (call === undefined) {
      throw new Error(`Telegram ${method} call containing ${text} missing`);
    }
    return call;
  }

  private async authoritativePaymentState(gameId: GameId): Promise<unknown> {
    const settlements = await this.pool.query<{
      settlement_id: string;
      revision: number;
      total_minor: string;
      charge_id: string;
      amount_minor: string;
      status: string;
    }>(
      `SELECT
         settlement.id AS settlement_id,
         settlement.revision,
         settlement.total_minor::text AS total_minor,
         charge.id AS charge_id,
         charge.amount_minor::text AS amount_minor,
         charge.status
       FROM settlements AS settlement
       JOIN settlement_charges AS charge ON charge.settlement_id = settlement.id
       WHERE settlement.game_id = $1
       ORDER BY settlement.revision, charge.id`,
      [gameId],
    );
    const events = await this.pool.query<{
      charge_id: string;
      count: string;
    }>(
      `SELECT event.charge_id, count(*)::text AS count
       FROM charge_status_events AS event
       JOIN settlement_charges AS charge ON charge.id = event.charge_id
       JOIN settlements AS settlement ON settlement.id = charge.settlement_id
       WHERE settlement.game_id = $1
       GROUP BY event.charge_id
       ORDER BY event.charge_id`,
      [gameId],
    );
    return { settlements: settlements.rows, statusEvents: events.rows };
  }

  private updateIdFor(idempotencyKey: string): number {
    const existing = this.updateIdsByIdempotencyKey.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const updateId = this.nextUpdateId();
    this.updateIdsByIdempotencyKey.set(idempotencyKey, updateId);
    return updateId;
  }

  private nextUpdateId(): number {
    const updateId = this.updateSequence;
    this.updateSequence += 1;
    return updateId;
  }

  private async ensureApi(): Promise<void> {
    if (this.apiApp !== undefined) return;
    this.previousApiEnv = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: this.databaseUrl,
      REDIS_URL: this.redisUrl,
      BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: '0123456789abcdef',
      PUBLIC_BASE_URL: 'https://localhost:3000',
      LOG_LEVEL: 'info',
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication(
      new FastifyAdapter() as never,
    ) as unknown as ProductionAppLike;
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    this.apiApp = app;
  }

  private injectApi(
    groupId: GroupId,
    gameId: GameId,
    telegramId: string,
  ): Promise<HttpResponseLike> {
    return this.apiApp!.getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/v1/groups/${groupId}/games/${gameId}`,
        headers: { authorization: signAuthorization(telegramId) },
      });
  }

  private async closeApi(): Promise<void> {
    await this.apiApp?.close();
    this.apiApp = undefined;
    if (this.previousApiEnv !== undefined) {
      replaceEnvironment(this.previousApiEnv);
      this.previousApiEnv = undefined;
    }
  }
}

const membershipUpdate = (
  updateId: number,
  groupChatId: string,
  administratorTelegramId: string,
) => ({
  update_id: updateId,
  my_chat_member: {
    chat: {
      id: Number(groupChatId),
      type: 'supergroup' as const,
      title: `Group ${groupChatId}`,
    },
    from: {
      id: Number(administratorTelegramId),
      is_bot: false,
      first_name: 'Admin',
    },
    date: Math.floor(Date.now() / 1_000),
    old_chat_member: { user: BOT_INFO, status: 'left' as const },
    new_chat_member: { user: BOT_INFO, status: 'member' as const },
  },
});

const botApiButtons = (
  call: BotApiCall,
): Array<{ text: string; callback_data: string }> => {
  const markup = call.payload.reply_markup as
    | {
        inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
      }
    | undefined;
  return markup?.inline_keyboard?.flat() ?? [];
};

const onboardingMessagePayload = (
  chatId: ReturnType<typeof asTelegramId>,
  text: string,
  options: Parameters<TelegramGateway['sendMessage']>[2],
): Record<string, unknown> => ({
  chat_id: chatId,
  text,
  parse_mode: options?.parseMode,
  reply_markup:
    options?.keyboard === undefined
      ? undefined
      : {
          inline_keyboard: options.keyboard.map((row) =>
            row.map((button) => ({
              text: button.text,
              callback_data: button.callbackData,
            })),
          ),
        },
});

const requiredButton = (call: BotApiCall, text: string) => {
  const button = botApiButtons(call).find(
    (candidate) => candidate.text === text,
  );
  if (button === undefined) throw new Error(`Telegram button ${text} missing`);
  return button;
};

const compactUuid = (value: string): string =>
  Buffer.from(value.replaceAll('-', ''), 'hex').toString('base64url');

const gameCallbackUpdate = (input: {
  updateId: number;
  telegramUserId: ReturnType<typeof asTelegramId>;
  chatId: ReturnType<typeof asTelegramId>;
  chatType: 'private' | 'supergroup';
  data: string;
}) => ({
  update_id: input.updateId,
  callback_query: {
    id: `acceptance-callback-${input.updateId}`,
    chat_instance: 'acceptance-management',
    from: {
      id: Number(input.telegramUserId),
      is_bot: false,
      first_name: 'Admin',
    },
    data: input.data,
    message: {
      message_id: input.updateId,
      date: Math.floor(Date.now() / 1_000),
      chat:
        input.chatType === 'private'
          ? {
              id: Number(input.chatId),
              type: 'private' as const,
              first_name: 'Admin',
            }
          : {
              id: Number(input.chatId),
              type: 'supergroup' as const,
              title: 'Acceptance group',
            },
      text: 'acceptance callback',
    },
  },
});

const privateCommandUpdate = (
  updateId: number,
  telegramUserId: ReturnType<typeof asTelegramId>,
  command: string,
  argument: string,
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1_000),
    chat: {
      id: Number(telegramUserId),
      type: 'private' as const,
      first_name: 'Admin',
    },
    from: {
      id: Number(telegramUserId),
      is_bot: false,
      first_name: 'Admin',
    },
    text: `/${command} ${argument}`,
    entities: [
      { offset: 0, length: command.length + 1, type: 'bot_command' as const },
    ],
  },
});

const privateTextUpdate = (input: {
  updateId: number;
  telegramUserId: ReturnType<typeof asTelegramId>;
  text: string;
  replyToText?: string;
}) => ({
  update_id: input.updateId,
  message: {
    message_id: input.updateId,
    date: Math.floor(Date.now() / 1_000),
    chat: {
      id: Number(input.telegramUserId),
      type: 'private' as const,
      first_name: 'Admin',
    },
    from: {
      id: Number(input.telegramUserId),
      is_bot: false,
      first_name: 'Admin',
    },
    text: input.text,
    ...(input.replyToText === undefined
      ? {}
      : {
          reply_to_message: {
            message_id: input.updateId - 1,
            date: Math.floor(Date.now() / 1_000),
            chat: {
              id: Number(input.telegramUserId),
              type: 'private' as const,
              first_name: 'Admin',
            },
            from: { id: BOT_INFO.id, is_bot: true, first_name: 'Volley' },
            text: input.replyToText,
          },
        }),
  },
});

const startUpdate = (
  updateId: number,
  administratorTelegramId: string,
  token: string,
) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1_000),
    chat: {
      id: Number(administratorTelegramId),
      type: 'private' as const,
      first_name: 'Admin',
    },
    from: {
      id: Number(administratorTelegramId),
      is_bot: false,
      first_name: 'Admin',
    },
    text: `/start ${token}`,
    entities: [{ offset: 0, length: 6, type: 'bot_command' as const }],
  },
});

const onboardingCallbackUpdate = (
  updateId: number,
  administratorTelegramId: string,
  data: string,
) => ({
  update_id: updateId,
  callback_query: {
    id: String(updateId),
    chat_instance: 'acceptance',
    from: {
      id: Number(administratorTelegramId),
      is_bot: false,
      first_name: 'Admin',
    },
    data,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1_000),
      chat: {
        id: Number(administratorTelegramId),
        type: 'private' as const,
        first_name: 'Admin',
      },
      text: 'configuration',
    },
  },
});

const templateSettings = (name: string, capacity: number) => ({
  name,
  venue: 'Central hall',
  address: '1 Volleyball Street',
  startsAtLocalTime: '19:00',
  durationMinutes: 120,
  capacity,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: 130_000n,
  currency: 'RUB' as const,
  roundingMode: 'EXACT' as const,
});

const signAuthorization = (telegramId: string): string => {
  const entries = [
    ['auth_date', String(Math.floor(Date.now() / 1_000))],
    ['query_id', `acceptance-${telegramId}`],
    [
      'user',
      JSON.stringify({ id: Number(telegramId), first_name: 'Acceptance' }),
    ],
  ] as const;
  const check = entries
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const raw = [...entries, ['hash', hash] as const]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  return `tma ${raw}`;
};

const replaceEnvironment = (next: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(process.env)) {
    if (!(key in next)) delete process.env[key];
  }
  Object.assign(process.env, next);
};
