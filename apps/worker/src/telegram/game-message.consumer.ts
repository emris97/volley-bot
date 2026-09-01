import { Module } from '@nestjs/common';
import { parseEnv } from '@volley/config';
import { asGameId, asGroupId } from '@volley/domain';
import { createDatabase, GameMessageRepository } from '@volley/persistence';
import {
  createTelegramBot,
  GameMessageUpdater,
  GrammyTelegramGateway,
  type GameMessageTelegramGateway,
  type RenderedTelegramMessage,
} from '@volley/telegram';
import { Worker } from 'bullmq';
import { Pool } from 'pg';
import type { ManagedWorker } from '../worker-lifecycle.service.js';

const refreshEventTypes = new Set([
  'GAME_CREATED',
  'GAME_UPDATED',
  'GAME_STATE_CHANGED',
  'REGISTRATION_CHANGED',
]);

export class GameMessageConsumer {
  public constructor(private readonly updater: GameMessageUpdater) {}

  public async process(
    eventType: string,
    payload: Record<string, unknown>,
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
  }
}

export class GameMessageWorkerRuntime implements ManagedWorker {
  public constructor(
    private readonly worker: Worker,
    private readonly closeResources: () => Promise<void>,
  ) {}

  public async start(): Promise<void> {
    void this.worker.run();
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
        const repository = new GameMessageRepository(createDatabase(pool));
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
        const consumer = new GameMessageConsumer(
          new GameMessageUpdater(repository, gateway),
        );
        const worker = new Worker(
          'volley-outbox',
          async (job) => consumer.process(job.name, job.data),
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
