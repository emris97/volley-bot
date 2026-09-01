import { describe, expect, it } from 'vitest';
import { TestSystem } from './fixtures/test-system.js';

describe('notification lifecycle recovery', () => {
  it('rebuilds jobs and converges Telegram state after Redis loss', async () => {
    const system = new TestSystem();
    const game = await system.createScheduledGame({ capacity: 1 });
    const userA = await system.registerTentative(game, '42');

    await system.reconcileJobs();
    await system.flushRedis();
    expect(await system.redisJobCount()).toBe(0);

    await system.reconcileJobs();
    await system.clock.advanceTo(game.tentativePromptAt);
    await system.drainWorkers();

    expect(system.telegram.privateMessagesFor(userA)).toContainEqual(
      expect.objectContaining({ buttons: ['Подтверждаю', 'Снимаюсь'] }),
    );
    expect(await system.pendingRequiredJobs(game.id!)).toEqual([]);
  });
});
