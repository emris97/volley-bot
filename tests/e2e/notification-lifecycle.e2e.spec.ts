import { asTelegramId } from '@volley/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MvpAcceptanceSystem } from './fixtures/mvp-acceptance-system.js';
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

describe('material notification lifecycle', () => {
  let system: MvpAcceptanceSystem;

  beforeAll(async () => {
    system = await MvpAcceptanceSystem.start();
  }, 60_000);

  beforeEach(async () => system.reset());
  afterAll(async () => system.stop());

  it('routes a persisted update and deduplicates recipient delivery', async () => {
    const fixture = await system.createOpenGame({ capacity: 2 });
    const registration = await system.registerMember(
      fixture,
      '4301',
      'material-notification-member',
    );

    const result = await system.updateVenueAndDeliverNotification(
      fixture,
      'Новый зал',
    );

    expect(system.telegram.privateMessagesFor(asTelegramId('4301'))).toEqual([
      expect.objectContaining({
        text:
          `Игра «${fixture.game.name}» изменена:\n` +
          'Было: 10.09.2026, 20:00 — Central hall — 1 Volleyball Street\n' +
          'Стало: 10.09.2026, 20:00 — Новый зал — 1 Volleyball Street',
      }),
    ]);
    expect(result.game.venue).toBe('Новый зал');
    await expect(
      system.notificationWasDelivered(
        result.deterministicJobId,
        registration.registrationId,
      ),
    ).resolves.toBe(true);
  });
});
