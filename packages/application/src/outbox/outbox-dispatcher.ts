import type { JobPublisher, OutboxClaimStore } from './outbox-event.js';

export interface OutboxDispatcherOptions {
  batchSize: number;
  leaseDurationMs: number;
  now: () => Date;
}

export interface DispatchResult {
  claimed: number;
  published: number;
  failed: number;
}

const defaultOptions: OutboxDispatcherOptions = {
  batchSize: 100,
  leaseDurationMs: 60_000,
  now: () => new Date(),
};

export class OutboxDispatcher {
  private readonly options: OutboxDispatcherOptions;

  public constructor(
    private readonly store: OutboxClaimStore,
    private readonly publisher: JobPublisher,
    options: Partial<OutboxDispatcherOptions> = {},
  ) {
    this.options = { ...defaultOptions, ...options };
  }

  public async dispatchOnce(): Promise<DispatchResult> {
    const now = this.options.now();
    const leaseUntil = new Date(now.getTime() + this.options.leaseDurationMs);
    const events = await this.store.claimBatch(
      this.options.batchSize,
      leaseUntil,
      now,
    );
    let published = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await this.publisher.publish({
          id: `outbox:${event.id}`,
          type: event.type,
          payload: event.payload,
          occurredAt: event.occurredAt,
        });
      } catch (error) {
        failed += 1;
        await this.store.release(event.id, errorMessage(error));
        continue;
      }

      await this.store.markPublished(event.id);
      published += 1;
    }

    return { claimed: events.length, published, failed };
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
