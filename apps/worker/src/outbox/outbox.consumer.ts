import { Logger } from '@nestjs/common';
import type { JobPublisher, PublishedJob } from '@volley/application';
import { OutboxDispatcher } from '@volley/application';
import { Queue } from 'bullmq';
import type { ManagedWorker } from '../worker-lifecycle.service.js';

export class BullMqJobPublisher implements JobPublisher {
  public constructor(private readonly queue: Queue) {}

  public async publish(job: PublishedJob): Promise<void> {
    await this.queue.add(job.type, job.payload, {
      // BullMQ 6 reserves two-segment colon IDs; three segments remain valid
      // for backwards-compatible repeatable-job keys.
      jobId: `${job.id}:event`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800 },
    });
  }
}

export class OutboxConsumer implements ManagedWorker {
  private readonly logger = new Logger(OutboxConsumer.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  public constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly closeResources: () => Promise<void>,
    private readonly intervalMs = 1_000,
  ) {}

  public async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.closeResources();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatcher.dispatchOnce();
    } catch (error) {
      this.logger.error(
        'Outbox dispatch failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
