import { Module } from '@nestjs/common';
import { parseEnv } from '@volley/config';
import { createDatabase, OutboxRepository } from '@volley/persistence';
import { OutboxDispatcher } from '@volley/application';
import { Queue } from 'bullmq';
import { Pool } from 'pg';
import { BullMqJobPublisher, OutboxConsumer } from './outbox.consumer.js';

export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');

@Module({
  providers: [
    {
      provide: OUTBOX_WORKER,
      useFactory: () => {
        const env = parseEnv(process.env);
        const pool = new Pool({ connectionString: env.DATABASE_URL });
        const redis = new URL(env.REDIS_URL);
        const queue = new Queue('volley-outbox', {
          connection: {
            host: redis.hostname,
            port: Number(redis.port || 6379),
            password: redis.password || undefined,
          },
        });
        const dispatcher = new OutboxDispatcher(
          new OutboxRepository(createDatabase(pool)),
          new BullMqJobPublisher(queue),
        );
        return new OutboxConsumer(dispatcher, async () => {
          await queue.close();
          await pool.end();
        });
      },
    },
  ],
  exports: [OUTBOX_WORKER],
})
export class OutboxModule {}
