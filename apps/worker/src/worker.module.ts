import { Module } from '@nestjs/common';
import { WorkerLifecycleService } from './worker-lifecycle.service.js';
import { OutboxModule } from './outbox/outbox.module.js';

@Module({
  imports: [OutboxModule],
  providers: [WorkerLifecycleService],
})
export class WorkerModule {}
