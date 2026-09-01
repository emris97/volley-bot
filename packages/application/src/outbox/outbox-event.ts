export interface ClaimedOutboxEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface PublishedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface OutboxClaimStore {
  claimBatch(
    limit: number,
    leaseUntil: Date,
    now?: Date,
  ): Promise<readonly ClaimedOutboxEvent[]>;
  markPublished(id: string): Promise<void>;
  release(id: string, error: string): Promise<void>;
}

export interface JobPublisher {
  publish(job: PublishedJob): Promise<void>;
}
