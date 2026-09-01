import { and, asc, eq, gt, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { outboxEvents } from '../schema/index.js';

interface ClaimedRow extends Record<string, unknown> {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  group_id: string;
  aggregate_type: string;
  aggregate_id: string;
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
      RETURNING
        event.id,
        event.event_type,
        event.payload,
        event.occurred_at,
        event.group_id,
        event.aggregate_type,
        event.aggregate_id
    `);

    return result.rows.map((row) => ({
      id: row.id,
      type: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      groupId: row.group_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
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

  public async listReplayBatch(
    limit: number,
    after?: { occurredAt: Date; id: string },
  ): Promise<
    readonly {
      id: string;
      type: string;
      payload: Record<string, unknown>;
      occurredAt: Date;
      groupId: string;
      aggregateType: string;
      aggregateId: string;
    }[]
  > {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const rows = await this.database
      .select()
      .from(outboxEvents)
      .where(
        after === undefined
          ? undefined
          : or(
              gt(outboxEvents.occurredAt, after.occurredAt),
              and(
                eq(outboxEvents.occurredAt, after.occurredAt),
                gt(outboxEvents.id, after.id),
              ),
            ),
      )
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      type: row.eventType,
      payload: row.payload,
      occurredAt: row.occurredAt,
      groupId: row.groupId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
    }));
  }
}
