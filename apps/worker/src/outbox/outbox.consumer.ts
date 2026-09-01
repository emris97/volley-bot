import { Logger } from '@nestjs/common';
import type {
  JobPublisher,
  MetricsRegistry,
  PublishedJob,
} from '@volley/application';
import { OutboxDispatcher } from '@volley/application';
import { Queue } from 'bullmq';
import type { ManagedWorker } from '../worker-lifecycle.service.js';

export class BullMqJobPublisher implements JobPublisher {
  public constructor(
    private readonly queue: Queue,
    private readonly metrics?: MetricsRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async publish(job: PublishedJob): Promise<void> {
    this.metrics?.observeOutboxLag(
      Math.max(0, this.now().getTime() - job.occurredAt.getTime()) / 1_000,
    );
    try {
      const jobId = `${job.id}:event`;
      const existing = await this.queue.getJob(jobId);
      if (existing !== undefined) {
        const state = await existing.getState();
        if (state === 'failed') {
          await existing.retry();
          this.metrics?.recordJobRetry('outbox');
          return;
        }
        if (state !== 'completed') return;
        await existing.remove();
      }
      await this.queue.add(job.type, job.payload, {
        // BullMQ 6 reserves two-segment colon IDs; three segments remain valid
        // for backwards-compatible repeatable-job keys.
        jobId,
        attempts: 12,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: { age: 604_800 },
      });
    } finally {
      await this.sampleQueueDepth();
    }
  }

  private async sampleQueueDepth(): Promise<void> {
    if (this.metrics === undefined) return;
    try {
      this.metrics.setQueueDepth('outbox', await this.queue.count());
    } catch {
      // Delivery must not fail because telemetry sampling is unavailable.
    }
  }
}

export class OutboxConsumer implements ManagedWorker {
  private readonly logger = new Logger(OutboxConsumer.name);
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopping = false;

  public constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly closeResources: () => Promise<void>,
    private readonly intervalMs = 1_000,
    private readonly purgeExpiredPaymentState: () => Promise<unknown> = async () =>
      undefined,
  ) {}

  public async start(): Promise<void> {
    this.stopping = false;
    await this.tick();
    if (this.stopping) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    await this.closeResources();
  }

  private tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight !== undefined) return this.inFlight;
    const operation = this.runTick().finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  private async runTick(): Promise<void> {
    try {
      await this.dispatcher.dispatchOnce();
    } catch (error) {
      this.logger.error(
        'Outbox dispatch failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
    try {
      await this.purgeExpiredPaymentState();
    } catch (error) {
      this.logger.error(
        'Payment state maintenance failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
