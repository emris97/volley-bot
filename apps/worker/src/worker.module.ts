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

@Module({
  imports: [OutboxModule, GameSchedulerModule],
  providers: [
    {
      provide: MANAGED_WORKERS,
      inject: [OUTBOX_WORKER, GAME_SCHEDULER_WORKER],
      useFactory: (
        outbox: ManagedWorker,
        scheduler: ManagedWorker,
      ): readonly ManagedWorker[] => [outbox, scheduler],
    },
    WorkerLifecycleService,
  ],
})
export class WorkerModule {}
