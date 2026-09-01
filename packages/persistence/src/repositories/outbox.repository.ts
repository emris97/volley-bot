import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { outboxEvents } from '../schema/index.js';

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export class OutboxRepository {
  public constructor(private readonly database: Database) {}

  public async claimBatch(
    limit: number,
    leaseUntil: Date,
    now = new Date(),
  ): Promise<
    readonly {
      id: string;
      type: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
    }[]
  > {
    if (!Number.isInteger(limit) || limit <= 0) return [];

    const result = await this.database.execute<ClaimedRow>(sql`
      WITH candidates AS (
        SELECT id
        FROM outbox_events
        WHERE published_at IS NULL
          AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
        ORDER BY occurred_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE outbox_events AS event
      SET claimed_at = ${now}, claim_expires_at = ${leaseUntil}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event.event_type, event.payload, event.occurred_at
    `);

    return result.rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
    }));
  }

  public async markPublished(id: string): Promise<void> {
    await this.database
      .update(outboxEvents)
      .set({
        publishedAt: new Date(),
        claimExpiresAt: null,
        lastError: null,
      })
      .where(eq(outboxEvents.id, id));
  }

  public async release(id: string, error: string): Promise<void> {
    await this.database
      .update(outboxEvents)
      .set({
        claimedAt: null,
        claimExpiresAt: null,
        lastError: error.slice(0, 1_000),
        attemptCount: sql`${outboxEvents.attemptCount} + 1`,
      })
      .where(eq(outboxEvents.id, id));
  }
}
