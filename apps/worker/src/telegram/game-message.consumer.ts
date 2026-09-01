import { Logger, Module } from '@nestjs/common';
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
import { Worker } from 'bullmq';
import { Pool } from 'pg';
import type { ManagedWorker } from '../worker-lifecycle.service.js';
import { NotificationConsumer } from '../notifications/notification.consumer.js';

const refreshEventTypes = new Set([
  'GAME_CREATED',
  'GAME_UPDATED',
  'GAME_STATE_CHANGED',
  'REGISTRATION_CHANGED',
  'WAITLIST_PROMOTED',
]);

export class GameMessageConsumer {
  public constructor(
    private readonly updater: GameMessageUpdater,
    private readonly handlePromotion: (
      registrationId: ReturnType<typeof asRegistrationId>,
      deterministicEventId: string,
    ) => Promise<void> = async () => undefined,
  ) {}

  public async process(
    eventType: string,
    payload: Record<string, unknown>,
    deterministicEventId?: string,
  ): Promise<void> {
    if (!refreshEventTypes.has(eventType) || payload.aggregateType !== 'GAME') {
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
    if (eventType === 'WAITLIST_PROMOTED') {
      if (typeof payload.registrationId !== 'string') {
        throw new Error('Promoted registration identity is required');
      }
      await this.handlePromotion(
        asRegistrationId(payload.registrationId),
        deterministicEventId ?? `WAITLIST_PROMOTED:${payload.registrationId}`,
      );
    }
  }
}

export class GameMessageWorkerRuntime implements ManagedWorker {
  private readonly logger = new Logger(GameMessageWorkerRuntime.name);
  public constructor(
    private readonly worker: Worker,
    private readonly closeResources: () => Promise<void>,
  ) {}

  public async start(): Promise<void> {
    void this.worker.run().catch((error: unknown) => {
      this.logger.error(
        'Game message worker stopped unexpectedly',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  public async stop(): Promise<void> {
    await this.worker.close();
    await this.closeResources();
  }
}

export const GAME_MESSAGE_WORKER = Symbol('GAME_MESSAGE_WORKER');

@Module({
  providers: [
    {
      provide: GAME_MESSAGE_WORKER,
      useFactory: () => {
        const env = parseEnv(process.env);
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        const database = createDatabase(pool);
        const repository = new GameMessageRepository(database);
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
        );
        const consumer = new GameMessageConsumer(
          new GameMessageUpdater(repository, gateway),
          (registrationId, deterministicEventId) =>
            notificationConsumer.processWaitlistPromotion(
              registrationId,
              deterministicEventId,
            ),
        );
        const worker = new Worker(
          'volley-outbox',
          async (job) => consumer.process(job.name, job.data, job.id),
          { connection: redisConnection(env.REDIS_URL), autorun: false },
        );
        return new GameMessageWorkerRuntime(worker, () => pool.end());
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

const redisConnection = (redisUrl: string) => {
  const redis = new URL(redisUrl);
  return {
    host: redis.hostname,
    port: Number(redis.port || 6379),
    password: redis.password || undefined,
  };
};
