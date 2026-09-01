import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

export interface ManagedWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const MANAGED_WORKERS = Symbol('MANAGED_WORKERS');

@Injectable()
export class WorkerLifecycleService
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(MANAGED_WORKERS)
    private readonly workers: readonly ManagedWorker[],
  ) {}

  async start(): Promise<void> {
    for (const worker of this.workers) {
      await worker.start();
    }
  }

  async stop(): Promise<void> {
    for (const worker of [...this.workers].reverse()) {
      await worker.stop();
    }
  }

  async onModuleInit(): Promise<void> {
    await this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }
}
