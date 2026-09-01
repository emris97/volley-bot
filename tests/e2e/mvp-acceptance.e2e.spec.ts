import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MvpAcceptanceSystem } from './fixtures/mvp-acceptance-system.js';

describe('volleyball bot MVP acceptance', () => {
  let system: MvpAcceptanceSystem;

  beforeAll(async () => {
    system = await MvpAcceptanceSystem.start();
  }, 120_000);

  beforeEach(async () => {
    await system.reset();
  });

  afterAll(async () => {
    await system?.stop();
  });

  it('administrator self-onboards an unconfigured group', async () => {
    const group = await system.onboardAndConfigureGroup({
      telegramChatId: '-100000000001',
      administratorTelegramId: '1001',
      timeZone: 'Europe/Moscow',
    });

    expect(group).toMatchObject({
      enabled: true,
      onboardingState: 'CONFIGURED',
      timeZone: 'Europe/Moscow',
    });
    expect(system.telegram.groupMessages).toHaveLength(1);
    expect(system.telegram.privateMessagesFor('1001')).toContainEqual(
      expect.objectContaining({ text: 'onboarding:complete' }),
    );
  });

  it('two groups keep settings and data isolated', async () => {
    const groupA = await system.onboardAndConfigureGroup({
      telegramChatId: '-100000000011',
      administratorTelegramId: '1011',
      timeZone: 'Europe/Moscow',
    });
    const groupB = await system.onboardAndConfigureGroup({
      telegramChatId: '-100000000012',
      administratorTelegramId: '1012',
      timeZone: 'Asia/Yekaterinburg',
    });
    const gameA = await system.createScratchGame(
      groupA.id,
      groupA.ownerUserId,
      {
        name: 'Group A game',
        capacity: 6,
      },
    );

    expect(await system.getGame(groupA.id, gameA.id!)).not.toBeNull();
    expect(await system.getGame(groupB.id, gameA.id!)).toBeNull();
    expect(await system.listGames(groupB.id)).toEqual([]);
    expect(groupA.timeZone).not.toBe(groupB.timeZone);
  });

  it('organizer publishes template and scratch games', async () => {
    const group = await system.createConfiguredGroup('1021');
    const template = await system.createTemplate(
      group.id,
      group.ownerUserId,
      'Tuesday volleyball',
    );
    const templated = await system.createGameFromTemplate(
      group.id,
      group.ownerUserId,
      template.id!,
    );
    const scratch = await system.createScratchGame(
      group.id,
      group.ownerUserId,
      {
        name: 'One-off game',
        capacity: 8,
      },
    );
    await system.publishGame(group.id, templated.id!, group.ownerUserId);
    await system.publishGame(group.id, scratch.id!, group.ownerUserId);

    expect(await system.listGames(group.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: templated.id, state: 'OPEN' }),
        expect.objectContaining({ id: scratch.id, state: 'OPEN' }),
      ]),
    );
  });

  it('participant manages self guest and tentative registrations without free text', async () => {
    const fixture = await system.createOpenGame({ capacity: 4 });

    const self = await system.registerMember(fixture, '1031', 'self-click');
    const guest = await system.registerGuest(
      fixture,
      self.userId,
      'Named guest',
      'guest-private-flow',
    );
    const tentative = await system.registerTentative(
      fixture,
      '1032',
      'tentative-click',
    );
    await system.withdraw(fixture, self.registrationId, self.userId);

    expect(guest.state).toBe('ROSTERED');
    expect(tentative.state).toBe('TENTATIVE');
    expect(await system.registrationState(self.registrationId)).toBe(
      'CANCELLED',
    );
  });

  it('concurrent final-place clicks produce one roster entry', async () => {
    const fixture = await system.createOpenGame({ capacity: 1 });
    const [first, second] = await Promise.all([
      system.registerMember(fixture, '1041', 'last-place-a'),
      system.registerMember(fixture, '1042', 'last-place-b'),
    ]);

    expect([first.state, second.state].toSorted()).toEqual([
      'ROSTERED',
      'WAITLISTED',
    ]);
    expect(await system.registrationCounts(fixture.game.id!)).toEqual({
      roster: 1,
      waitlist: 1,
      tentative: 0,
    });
  });

  it('member priority and audited administrator override are deterministic', async () => {
    const fixture = await system.createOpenGame({ capacity: 1 });
    const guest = await system.registerGuest(
      fixture,
      fixture.organizerUserId,
      'Priority guest',
      'priority-guest',
    );
    const member = await system.registerMember(
      fixture,
      '1051',
      'priority-member',
    );

    expect(await system.registrationState(member.registrationId)).toBe(
      'ROSTERED',
    );
    expect(await system.registrationState(guest.registrationId)).toBe(
      'WAITLISTED',
    );

    await system.overrideOrder(
      fixture,
      guest.registrationId,
      fixture.organizerUserId,
      0,
    );

    expect(await system.registrationState(guest.registrationId)).toBe(
      'ROSTERED',
    );
    expect(await system.auditEventTypes(fixture.groupId)).toContain(
      'REGISTRATION_ORDER_CHANGED',
    );
  });

  it('tentative registration is prompted and expires without response', async () => {
    const fixture = await system.createOpenGame({ capacity: 2 });
    const tentative = await system.registerTentative(
      fixture,
      '1061',
      'tentative-expiry',
    );

    await system.scheduleAndDeliverTentativePrompt(fixture, tentative);
    expect(system.telegram.privateMessagesFor('1061')).toContainEqual(
      expect.objectContaining({ buttons: ['Подтверждаю', 'Снимаюсь'] }),
    );

    await system.expireTentative(fixture, tentative.registrationId);
    expect(await system.registrationState(tentative.registrationId)).toBe(
      'CANCELLED',
    );
  });

  it('withdrawal promotes and notifies the first eligible waiter', async () => {
    const fixture = await system.createOpenGame({ capacity: 1 });
    const rostered = await system.registerMember(
      fixture,
      '1071',
      'promotion-rostered',
    );
    const waiting = await system.registerMember(
      fixture,
      '1072',
      'promotion-waiting',
    );

    await system.withdraw(fixture, rostered.registrationId, rostered.userId);
    await system.deliverWaitlistPromotion(waiting.registrationId);

    expect(await system.registrationState(waiting.registrationId)).toBe(
      'ROSTERED',
    );
    expect(system.telegram.privateMessagesFor('1072')).toContainEqual(
      expect.objectContaining({
        text: 'Вы перешли из листа ожидания в основной состав',
      }),
    );
  });

  it('canonical message converges after duplicate and rapid changes', async () => {
    const fixture = await system.createOpenGame({ capacity: 2 });
    const update = system.createCanonicalMessageUpdater();

    await Promise.all([
      system.registerMember(fixture, '1081', 'rapid-a'),
      system.registerMember(fixture, '1082', 'rapid-b'),
      update.refresh(fixture.groupId, fixture.game.id!),
      update.refresh(fixture.groupId, fixture.game.id!),
    ]);
    await update.refresh(fixture.groupId, fixture.game.id!);

    expect(system.canonicalMessageText(fixture.game.id!)).toBe(
      await system.renderAuthoritativeGameMessage(
        fixture.groupId,
        fixture.game.id!,
      ),
    );
  });

  it('administrator confirms attendance splits total cost and marks payments', async () => {
    const fixture = await system.createCompletedGameWithRoster('1091');
    const attendance = await system.confirmAttendanceWithManualParticipant(
      fixture,
      'Late player',
    );
    const settlement = await system.finalizeSettlement(
      fixture,
      attendance.revision,
      '1300.00',
      'EXACT',
    );
    const paid = await system.markChargePaid(
      fixture,
      settlement.charges[0]!.id,
    );

    expect(attendance.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: 'Late player',
          addedManually: true,
        }),
      ]),
    );
    expect(settlement.charges).toHaveLength(2);
    expect(
      settlement.charges.reduce((sum, charge) => sum + charge.amountMinor, 0n),
    ).toBe(130000n);
    expect(paid.status).toBe('PAID');
  });

  it('Redis loss and duplicate updates preserve authoritative state', async () => {
    const fixture = await system.createOpenGame({ capacity: 1 });
    const first = await system.registerMember(
      fixture,
      '1101',
      'duplicate-update',
    );
    const duplicate = await system.registerMember(
      fixture,
      '1101',
      'duplicate-update',
    );

    await system.reconcileGameJobs(fixture);
    await system.flushRedis();
    await system.reconcileGameJobs(fixture);

    expect(duplicate.registrationId).toBe(first.registrationId);
    expect(await system.registrationCounts(fixture.game.id!)).toEqual({
      roster: 1,
      waitlist: 0,
      tentative: 0,
    });
    expect(await system.redisJobCount()).toBeGreaterThan(0);
  });

  it('Mini App API calls the same authorized application services', async () => {
    const fixture = await system.createOpenGame({ capacity: 3 });
    const apiResult = await system.getGameThroughProductionApi(fixture, '1111');
    const applicationResult = await system.getGame(
      fixture.groupId,
      fixture.game.id!,
    );

    expect(apiResult.statusCode).toBe(200);
    expect(apiResult.body).toMatchObject({
      id: applicationResult!.id,
      groupId: applicationResult!.groupId,
      state: applicationResult!.state,
    });
    expect(
      await system.getForeignGameThroughProductionApi(fixture, '1111'),
    ).toBe(404);
  });
});
