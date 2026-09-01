import { Logger, Module } from '@nestjs/common';
import { JsonLogger, MetricsRegistry } from '@volley/application';
import { parseEnv } from '@volley/config';
import { asGameId, asGroupId, asRegistrationId } from '@volley/domain';
import {
  createDatabase,
  GameMessageRepository,
  NotificationRepository,
  RegistrationRepository,
} from '@volley/persistence';
import {
  createTelegramBot,
  GameMessageUpdater,
  GrammyTelegramGateway,
  NotificationSender,
  TelegramPrivateChatUnavailableError,
  type GameMessageTelegramGateway,
  type RenderedTelegramMessage,
} from '@volley/telegram';
import { Queue, Worker } from 'bullmq';
import {
  WORKER_DEPENDENCIES,
  type WorkerDependencies,
} from '../infrastructure/worker-dependencies.module.js';
import type { ManagedWorker } from '../worker-lifecycle.service.js';
import { NotificationConsumer } from '../notifications/notification.consumer.js';
import { observeWorkerJob } from '../observability/worker-job-observability.js';

const refreshEventTypes = new Set([
  'GAME_CREATED',
  'GAME_UPDATED',
  'GAME_STATE_CHANGED',
  'REGISTRATION_CHANGED',
  'WAITLIST_PROMOTED',
  'GAME_RECOVERY_REFRESH',
]);

export class OutboxEventRouter {
  public constructor(
    private readonly canonicalQueue: Pick<Queue, 'add' | 'getJob'>,
    private readonly notificationQueue: Pick<Queue, 'add' | 'getJob'>,
    private readonly metrics?: MetricsRegistry,
    private readonly jobLogger?: JsonLogger,
  ) {}

  public async process(
    eventType: string,
    payload: Record<string, unknown>,
    sourceJobId: string,
    attemptsMade = 0,
  ): Promise<void> {
    await observeWorkerJob(
      this.metrics,
      this.jobLogger,
      {
        queue: 'outbox',
        jobId: sourceJobId,
        groupId:
          typeof payload.groupId === 'string' ? payload.groupId : undefined,
        gameId:
          typeof payload.aggregateId === 'string'
            ? payload.aggregateId
            : undefined,
        attemptsMade,
      },
      async () => {
        if (refreshEventTypes.has(eventType)) {
          await ensureChildJob(
            this.canonicalQueue,
            eventType,
            payload,
            childJobId(sourceJobId, 'canonical'),
          );
        }
        if (eventType === 'WAITLIST_PROMOTED') {
          await ensureChildJob(
            this.notificationQueue,
            eventType,
            payload,
            childJobId(sourceJobId, 'notification'),
          );
        }
      },
    );
  }
}

export class GameMessageConsumer {
  public constructor(
    private readonly updater: GameMessageUpdater,
    private readonly metrics?: MetricsRegistry,
    private readonly jobLogger?: JsonLogger,
  ) {}

  public async process(
    eventType: string,
    payload: Record<string, unknown>,
    jobId = `${eventType}:unknown`,
    attemptsMade = 0,
  ): Promise<void> {
    await observeWorkerJob(
      this.metrics,
      this.jobLogger,
      {
        queue: 'game-messages',
        jobId,
        groupId:
          typeof payload.groupId === 'string' ? payload.groupId : undefined,
        gameId:
          typeof payload.aggregateId === 'string'
            ? payload.aggregateId
            : undefined,
        attemptsMade,
      },
      async () => {
        if (
          !refreshEventTypes.has(eventType) ||
          payload.aggregateType !== 'GAME'
        ) {
          return;
        }
        if (
          typeof payload.groupId !== 'string' ||
          typeof payload.aggregateId !== 'string'
        ) {
          throw new Error('Game outbox event identity is required');
        }
        await this.updater.refresh(
          asGroupId(payload.groupId),
          asGameId(payload.aggregateId),
        );
      },
    );
  }
}

export class WaitlistPromotionConsumer {
  public constructor(
    private readonly notifications: NotificationConsumer,
    private readonly metrics?: MetricsRegistry,
    private readonly jobLogger?: JsonLogger,
  ) {}

  public async process(
    payload: Record<string, unknown>,
    deterministicEventId: string,
    attemptsMade = 0,
  ): Promise<void> {
    await observeWorkerJob(
      this.metrics,
      this.jobLogger,
      {
        queue: 'notifications',
        jobId: deterministicEventId,
        groupId:
          typeof payload.groupId === 'string' ? payload.groupId : undefined,
        gameId:
          typeof payload.aggregateId === 'string'
            ? payload.aggregateId
            : undefined,
        attemptsMade,
      },
      async () => {
        if (typeof payload.registrationId !== 'string') {
          throw new Error('Promoted registration identity is required');
        }
        await this.notifications.processWaitlistPromotion(
          asRegistrationId(payload.registrationId),
          deterministicEventId,
        );
      },
    );
  }
}

export class GameMessageWorkerRuntime implements ManagedWorker {
  private readonly logger = new Logger(GameMessageWorkerRuntime.name);
  public constructor(
    private readonly workers: readonly Worker[],
    private readonly closeResources: () => Promise<void>,
  ) {}

  public async start(): Promise<void> {
    for (const worker of this.workers) {
      void worker.run().catch((error: unknown) => {
        this.logger.error(
          `Telegram worker ${worker.name} stopped unexpectedly`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    }
  }

  public async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.closeResources();
  }
}

export const GAME_MESSAGE_WORKER = Symbol('GAME_MESSAGE_WORKER');

@Module({
  providers: [
    {
      provide: GAME_MESSAGE_WORKER,
      inject: [WORKER_DEPENDENCIES, MetricsRegistry, JsonLogger],
      useFactory: (
        dependencies: WorkerDependencies,
        metrics: MetricsRegistry,
        logger: JsonLogger,
      ) => {
        const env = parseEnv(process.env);
        const database = createDatabase(dependencies.pool);
        const repository = new GameMessageRepository(
          database,
          dependencies.pool,
        );
        const notifications = new NotificationRepository(database);
        const telegram = new GrammyTelegramGateway(
          createTelegramBot(env.BOT_TOKEN),
        );
        const gateway: GameMessageTelegramGateway = {
          editMessage: (chatId, messageId, message) =>
            telegram.editMessage(
              chatId,
              messageId,
              message.text,
              messageOptions(message),
            ),
          async sendMessage(chatId, message) {
            return telegram.sendMessage(
              chatId,
              message.text,
              messageOptions(message),
            );
          },
          pinMessage: (chatId, messageId) =>
            telegram.pinMessage(chatId, messageId),
        };
        const notificationSender = new NotificationSender(
          {
            async sendPrivate(telegramUserId, text, buttons) {
              try {
                await telegram.sendMessage(telegramUserId, text, {
                  parseMode: 'HTML',
                  keyboard: [
                    buttons.map((button) =>
                      typeof button === 'string'
                        ? { text: button, callbackData: 'noop' }
                        : button,
                    ),
                  ],
                });
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                if (/forbidden|chat not found|bot was blocked/i.test(message)) {
                  throw new TelegramPrivateChatUnavailableError(message);
                }
                throw error;
              }
            },
            async sendGroupMessage(groupChatId, text) {
              await telegram.sendMessage(groupChatId, text, {
                parseMode: 'HTML',
              });
            },
          },
          notifications,
        );
        const notificationConsumer = new NotificationConsumer(
          notifications,
          notificationSender,
          new RegistrationRepository(database),
          metrics,
        );
        const canonicalQueue = new Queue('volley-game-messages', {
          connection: dependencies.redis,
        });
        const notificationQueue = new Queue('volley-notifications', {
          connection: dependencies.redis,
        });
        const router = new OutboxEventRouter(
          canonicalQueue,
          notificationQueue,
          metrics,
          logger,
        );
        const messageConsumer = new GameMessageConsumer(
          new GameMessageUpdater(repository, gateway),
          metrics,
          logger,
        );
        const promotionConsumer = new WaitlistPromotionConsumer(
          notificationConsumer,
          metrics,
          logger,
        );
        const routerWorker = new Worker(
          'volley-outbox',
          async (job) =>
            router.process(
              job.name,
              job.data,
              requiredJobId(job.id),
              job.attemptsMade,
            ),
          { connection: dependencies.redis, autorun: false },
        );
        const messageWorker = new Worker(
          'volley-game-messages',
          async (job) =>
            messageConsumer.process(
              job.name,
              job.data,
              requiredJobId(job.id),
              job.attemptsMade,
            ),
          { connection: dependencies.redis, autorun: false },
        );
        const promotionWorker = new Worker(
          'volley-notifications',
          async (job) =>
            promotionConsumer.process(
              job.data,
              requiredJobId(job.id),
              job.attemptsMade,
            ),
          { connection: dependencies.redis, autorun: false },
        );
        return new GameMessageWorkerRuntime(
          [routerWorker, messageWorker, promotionWorker],
          async () => {
            await Promise.all([
              canonicalQueue.close(),
              notificationQueue.close(),
            ]);
          },
        );
      },
    },
  ],
  exports: [GAME_MESSAGE_WORKER],
})
export class GameMessageWorkerModule {}

const messageOptions = (message: RenderedTelegramMessage) => ({
  parseMode: message.parseMode,
  keyboard: message.keyboard,
});

const childJobOptions = (jobId: string) => ({
  jobId,
  attempts: 12,
  backoff: { type: 'exponential' as const, delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800 },
});

const ensureChildJob = async (
  queue: Pick<Queue, 'add' | 'getJob'>,
  name: string,
  payload: Record<string, unknown>,
  jobId: string,
): Promise<void> => {
  const existing = await queue.getJob(jobId);
  if (existing !== undefined) {
    if ((await existing.getState()) === 'failed') await existing.retry();
    return;
  }
  await queue.add(name, payload, childJobOptions(jobId));
};

const requiredJobId = (jobId: string | undefined): string => {
  if (jobId === undefined) throw new Error('BullMQ job identity is required');
  return jobId;
};

const childJobId = (
  sourceJobId: string,
  consumer: 'canonical' | 'notification',
): string => {
  const [prefix, eventId, suffix, ...rest] = sourceJobId.split(':');
  if (
    prefix !== 'outbox' ||
    eventId === undefined ||
    suffix !== 'event' ||
    rest.length > 0
  ) {
    throw new Error('Invalid outbox parent job identity');
  }
  return `outbox:${eventId}:${consumer}`;
};
