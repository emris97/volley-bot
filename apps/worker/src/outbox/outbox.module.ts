import { Module } from '@nestjs/common';
import {
  createDatabase,
  OutboxRepository,
  PaymentRepository,
} from '@volley/persistence';
import { OutboxDispatcher } from '@volley/application';
import { MetricsRegistry } from '@volley/application';
import { Queue } from 'bullmq';
import {
  WORKER_DEPENDENCIES,
  type WorkerDependencies,
} from '../infrastructure/worker-dependencies.module.js';
import { BullMqJobPublisher, OutboxConsumer } from './outbox.consumer.js';
import {
  WORKER_RUN_STATE,
  type WorkerRunStateRegistry,
} from '../observability/worker-run-state.js';

export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');

@Module({
  providers: [
    {
      provide: OUTBOX_WORKER,
      inject: [WORKER_DEPENDENCIES, MetricsRegistry, WORKER_RUN_STATE],
      useFactory: (
        dependencies: WorkerDependencies,
        metrics: MetricsRegistry,
        runState: WorkerRunStateRegistry,
      ) => {
        const queue = new Queue('volley-outbox', {
          connection: dependencies.redis,
        });
        const database = createDatabase(dependencies.pool);
        const payments = new PaymentRepository(database);
        const dispatcher = new OutboxDispatcher(
          new OutboxRepository(database),
          new BullMqJobPublisher(queue, metrics),
        );
        return new OutboxConsumer(
          dispatcher,
          async () => {
            await queue.close();
          },
          1_000,
          () => payments.purgeExpiredState({ batchSize: 500 }),
          runState,
        );
      },
    },
  ],
  exports: [OUTBOX_WORKER],
})
export class OutboxModule {}
