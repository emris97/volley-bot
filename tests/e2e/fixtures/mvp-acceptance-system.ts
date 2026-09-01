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
  ExpireTentative,
  FinalizeSettlement,
  GetGame,
  OnboardGroup,
  ReconcileGameJobs,
  RegisterGuest,
  RegisterParticipant,
  WithdrawRegistration,
  type ConfigurationLinkFactory,
} from '@volley/application';
import {
  asGameId,
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
  GroupRepository,
  NotificationRepository,
  PaymentRepository,
  RegistrationRepository,
  ScheduledJobRepository,
  TemplateRepository,
  type Database,
} from '@volley/persistence';
import {
  GameMessageUpdater,
  NotificationSender,
  renderGameMessage,
  tentativeCallback,
  type RenderedTelegramMessage,
} from '@volley/telegram';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { AppModule } from '../../../apps/api/src/app.module.js';
import { BullMqDelayedJobScheduler } from '../../../apps/worker/src/scheduling/game-scheduler.consumer.js';
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

interface QueueLike {
  close(): Promise<void>;
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
const STARTS_AT = new Date('2026-09-10T16:00:00.000Z');

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
  private readonly confirmAttendance: ConfirmAttendance;
  private readonly finalizeSettlementUseCase: FinalizeSettlement;
  private readonly changeChargeStatus: ChangeChargeStatus;
  private readonly expireTentativeUseCase: ExpireTentative;
  private readonly messageRepository: GameMessageRepository;
  private readonly reconciler: ReconcileGameJobs;
  private readonly sender: NotificationSender;
  private apiApp?: ProductionAppLike;
  private previousApiEnv?: NodeJS.ProcessEnv;
  private groupSequence = 20_000;

  private constructor(
    private readonly postgres: StartedTestContainer,
    private readonly redisContainer: StartedTestContainer,
    private readonly pool: PoolLike,
    private readonly database: Database,
    private readonly redis: RedisLike,
    private readonly queue: QueueLike,
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
    this.confirmAttendance = new ConfirmAttendance(
      this.authorization,
      this.attendance,
    );
    this.finalizeSettlementUseCase = new FinalizeSettlement(
      this.authorization,
      this.payments,
    );
    this.changeChargeStatus = new ChangeChargeStatus(
      this.authorization,
      this.payments,
    );
    this.expireTentativeUseCase = new ExpireTentative(this.registrations);
    this.messageRepository = new GameMessageRepository(database, pool as never);
    this.reconciler = new ReconcileGameJobs(
      new ScheduledJobRepository(database),
      new BullMqDelayedJobScheduler(queue as never),
    );
    this.sender = new NotificationSender(this.telegram, this.notifications);
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
    const queue = new Queue(`mvp-acceptance-${Date.now()}`, {
      connection: {
        host: redisContainer.getHost(),
        port: redisContainer.getMappedPort(6379),
      },
    });
    return new MvpAcceptanceSystem(
      postgres,
      redisContainer,
      pool,
      database,
      redis,
      queue,
      databaseUrl,
      redisUrl,
    );
  }

  public async reset(): Promise<void> {
    await this.closeApi();
    await this.redis.flushall();
    await this.pool.query('TRUNCATE groups, users CASCADE');
    this.telegram.clear();
    this.canonicalTelegram.clear();
  }

  public async stop(): Promise<void> {
    await this.closeApi();
    await Promise.allSettled([
      this.queue.close(),
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
    timeZone: string;
  }): Promise<AcceptanceGroup> {
    const links: ConfigurationLinkFactory = {
      create: ({ groupId }) => `https://t.me/volley_test_bot?start=${groupId}`,
    };
    const onboarding = await new OnboardGroup(
      this.telegram,
      this.groups,
      links,
    ).execute({
      telegramChatId: asTelegramId(input.telegramChatId),
      telegramUserId: asTelegramId(input.administratorTelegramId),
      title: `Group ${input.telegramChatId}`,
    });
    await new ConfigureGroup(this.authorization, this.groups).execute({
      groupId: onboarding.groupId,
      actorTelegramId: asTelegramId(input.administratorTelegramId),
      timeZone: input.timeZone,
      memberPriorityEnabled: true,
      tentativePromptMinutesBefore: 1_440,
      tentativeResponseMinutes: 60,
      reminderMinutesBefore: 120,
      currency: 'RUB',
      roundingMode: 'EXACT',
      pinGameMessages: true,
    });
    const membership = await this.groups.findMembership(
      onboarding.groupId,
      asTelegramId(input.administratorTelegramId),
    );
    if (membership === null) throw new Error('Owner membership missing');
    await this.telegram.sendGroupMessage(
      asTelegramId(input.telegramChatId),
      'onboarding:configured',
    );
    await this.telegram.sendPrivate(
      asTelegramId(input.administratorTelegramId),
      'onboarding:complete',
      [],
    );
    const group = await this.groups.findById(onboarding.groupId);
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
      timeZone: 'Europe/Moscow',
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
    const result = await this.registerParticipant.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      userId: membership.userId,
      intent: 'CONFIRMED',
      idempotencyKey,
    });
    return { ...result, userId: membership.userId };
  }

  public async registerGuest(
    fixture: AcceptanceFixture,
    inviterUserId: UserId,
    guestDisplayName: string,
    idempotencyKey: string,
  ): Promise<AcceptanceRegistration> {
    const result = await this.registerGuestUseCase.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      inviterUserId,
      guestDisplayName,
      idempotencyKey,
    });
    return { ...result, userId: inviterUserId };
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
    const result = await this.registerParticipant.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      userId: membership.userId,
      intent: 'TENTATIVE',
      idempotencyKey,
    });
    return { ...result, userId: membership.userId };
  }

  public withdraw(
    fixture: AcceptanceFixture,
    registrationId: RegistrationId,
    actorUserId: UserId,
  ) {
    return this.withdrawRegistration.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      registrationId,
      actorUserId,
    });
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
    await this.reconcileGameJobs(fixture);
    const recipients = await this.notifications.listTentative(
      fixture.groupId,
      fixture.game.id!,
      fixture.game.scheduleRevision,
    );
    const recipient = recipients.find(
      (item) => item.registrationId === registration.registrationId,
    );
    if (recipient === undefined) throw new Error('Tentative recipient missing');
    await this.sender.send({
      notificationType: 'TENTATIVE_CONFIRMATION',
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      groupChatId: recipient.groupChatId,
      recipient,
      text: 'Подтвердите участие в игре',
      buttons: [
        {
          text: 'Подтверждаю',
          callbackData: tentativeCallback(
            registration.registrationId,
            0,
            'confirm',
          ),
        },
        {
          text: 'Снимаюсь',
          callbackData: tentativeCallback(
            registration.registrationId,
            0,
            'withdraw',
          ),
        },
      ],
    });
  }

  public expireTentative(
    fixture: AcceptanceFixture,
    registrationId: RegistrationId,
  ) {
    return this.expireTentativeUseCase.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      registrationId,
      expectedConfirmationRevision: 0,
    });
  }

  public async deliverWaitlistPromotion(
    registrationId: RegistrationId,
  ): Promise<void> {
    const recipient =
      await this.notifications.findByRegistration(registrationId);
    if (recipient === null) throw new Error('Promoted recipient missing');
    await this.sender.send({
      notificationType: 'WAITLIST_PROMOTED',
      groupId: recipient.groupId,
      gameId: recipient.gameId,
      groupChatId: recipient.groupChatId,
      recipient,
      text: 'Вы перешли из листа ожидания в основной состав',
      buttons: [],
    });
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

  public confirmAttendanceWithManualParticipant(
    fixture: AcceptanceFixture,
    displayName: string,
  ): Promise<AttendanceSnapshot> {
    return this.confirmAttendance.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      actorUserId: fixture.organizerUserId,
      expectedRevision: 0,
      excludedRegistrationIds: [],
      manualParticipants: [{ displayName, billable: true }],
      finalize: true,
    });
  }

  public finalizeSettlement(
    fixture: AcceptanceFixture,
    attendanceRevision: number,
    totalAmount: string,
    roundingMode: 'EXACT',
  ) {
    return this.finalizeSettlementUseCase.execute({
      groupId: fixture.groupId,
      gameId: fixture.game.id!,
      actorUserId: fixture.organizerUserId,
      attendanceRevision,
      totalAmount,
      currency: 'RUB',
      roundingMode,
    });
  }

  public markChargePaid(fixture: AcceptanceFixture, chargeId: string) {
    return this.changeChargeStatus.execute({
      groupId: fixture.groupId,
      actorUserId: fixture.organizerUserId,
      chargeId,
      status: 'PAID',
    });
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
