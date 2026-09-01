import { Module } from '@nestjs/common';
import {
  MANAGED_WORKERS,
  type ManagedWorker,
  WorkerLifecycleService,
} from './worker-lifecycle.service.js';
import { OutboxModule, OUTBOX_WORKER } from './outbox/outbox.module.js';
import {
  GAME_SCHEDULER_WORKER,
  GameSchedulerModule,
} from './scheduling/game-scheduler.module.js';
import {
  GAME_MESSAGE_WORKER,
  GameMessageWorkerModule,
} from './telegram/game-message.consumer.js';
import { WorkerObservabilityModule } from './observability/worker-observability.module.js';

@Module({
  imports: [
    WorkerObservabilityModule,
    OutboxModule,
    GameSchedulerModule,
    GameMessageWorkerModule,
  ],
  providers: [
    {
      provide: MANAGED_WORKERS,
      inject: [OUTBOX_WORKER, GAME_SCHEDULER_WORKER, GAME_MESSAGE_WORKER],
      useFactory: (
        outbox: ManagedWorker,
        scheduler: ManagedWorker,
        gameMessages: ManagedWorker,
      ): readonly ManagedWorker[] => [outbox, scheduler, gameMessages],
    },
    WorkerLifecycleService,
  ],
})
export class WorkerModule {}
