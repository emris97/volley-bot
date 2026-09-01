import { Module } from '@nestjs/common';
import {
  MANAGED_WORKERS,
  WorkerLifecycleService,
} from './worker-lifecycle.service.js';

@Module({
  providers: [
    { provide: MANAGED_WORKERS, useValue: [] },
    WorkerLifecycleService,
  ],
})
export class WorkerModule {}
