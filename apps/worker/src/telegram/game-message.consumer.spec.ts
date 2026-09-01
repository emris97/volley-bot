import { describe, expect, it, vi } from 'vitest';
import { asRegistrationId } from '@volley/domain';
import { GameMessageConsumer } from './game-message.consumer.js';

describe('GameMessageConsumer', () => {
  it('routes a waitlist promotion and refreshes the canonical message', async () => {
    const updater = { refresh: vi.fn() };
    const promote = vi.fn();
    const consumer = new GameMessageConsumer(updater as never, promote);
    const registrationId = asRegistrationId(
      '018f6ba0-62d2-7bd1-8f13-12e0c8424620',
    );

    await consumer.process('WAITLIST_PROMOTED', {
      groupId: '018f6ba0-62d2-7bd1-8f13-12e0c8424611',
      aggregateType: 'GAME',
      aggregateId: '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
      registrationId,
    });

    expect(updater.refresh).toHaveBeenCalledOnce();
    expect(promote).toHaveBeenCalledWith(
      registrationId,
      `WAITLIST_PROMOTED:${registrationId}`,
    );
  });
});
