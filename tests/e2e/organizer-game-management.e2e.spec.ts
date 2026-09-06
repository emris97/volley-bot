import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MvpAcceptanceSystem } from './fixtures/mvp-acceptance-system.js';

const UUID_PATTERN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/iu;

describe('organizer game management through Telegram', () => {
  let system: MvpAcceptanceSystem;

  beforeAll(async () => {
    system = await MvpAcceptanceSystem.start();
  }, 120_000);

  beforeEach(async () => system.reset());

  afterAll(async () => system.stop());

  it('takes an administrator from bare start through settlement without UUID commands', async () => {
    const adminTelegramId = '880001';
    const memberTelegramId = '880002';
    const group = await system.createConfiguredGroup(adminTelegramId);

    await system.sendPrivateCommand(adminTelegramId, '/start');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      'Главное меню',
    );

    await system.createTemplateThroughTelegram(adminTelegramId, {
      name: 'Вечерняя игра',
      venue: 'Спортзал Олимп',
      capacity: 8,
    });
    const game = await system.createAndPublishGameThroughTelegram(
      adminTelegramId,
      'Вечерняя игра',
    );
    expect(game.state).toBe('SCHEDULED');

    await system.deliverLatestCanonicalCard(game.id!);
    await system.runScheduledOpening(game.groupId, game.id!);
    await system.deliverLatestCanonicalCard(game.id!);
    await system.pressGoingThroughTelegram(
      memberTelegramId,
      game.groupId,
      game.id!,
    );
    await system.closeAndCompleteThroughTelegram(adminTelegramId, game.id!);
    await system.finalizeAttendanceThroughTelegram(adminTelegramId, game.id!);
    await system.finalizeSettlementThroughTelegram(adminTelegramId, game.id!);

    expect(await system.canonicalMessages(game.id!)).toHaveLength(1);
    expect(await system.finalizedAttendanceCount(game.id!)).toBe(1);
    expect(await system.finalizedSettlementCount(game.id!)).toBe(1);
    expect(system.callbackAnswerTexts()).toEqual(
      expect.arrayContaining(['Посещаемость обновлена.', 'Расчёт обновлён.']),
    );
    const visible = system.visibleMessages().join('\n');
    expect(visible).not.toMatch(UUID_PATTERN);
    expect(visible).not.toMatch(/attendance:|\b(?:PAID|UNPAID|WAIVED)\b/u);
    expect(system.latestPrivateMessage(adminTelegramId).text).not.toMatch(
      /\bRUB\b|\d+\.\d{2}/u,
    );
    expect(
      system.generatedCallbacks().every((value) => value.length < 64),
    ).toBe(true);
    expect(await system.getGame(group.id, game.id!)).toMatchObject({
      state: 'COMPLETED',
    });
  });

  it('requires a group choice, rechecks live admin rights, and rejects cross-group callbacks', async () => {
    const adminTelegramId = '880011';
    const first = await system.createConfiguredGroup(adminTelegramId);
    const second = await system.createConfiguredGroup(adminTelegramId);

    await system.clearOrganizerSelection(adminTelegramId);
    await system.sendPrivateCommand(adminTelegramId, '/start');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      'Выберите группу',
    );

    await system.pressPrivateButton(adminTelegramId, first.title);
    await system.createTemplateThroughTelegram(adminTelegramId, {
      name: 'Изолированный шаблон',
      venue: 'Первый зал',
      capacity: 8,
    });
    await system.sendPrivateCommand(adminTelegramId, '/templates');
    await system.pressPrivateButton(adminTelegramId, 'Изолированный шаблон');
    const callback = system.latestPrivateButton(adminTelegramId, 'В архив');

    await system.selectGroupThroughTelegram(adminTelegramId, second.title);
    await system.pressCallback(adminTelegramId, callback);
    expect(
      await system.templateIsArchived(first.id, 'Изолированный шаблон'),
    ).toBe(false);

    await system.selectGroupThroughTelegram(adminTelegramId, first.title);
    system.setTelegramMembership(first.telegramChatId, adminTelegramId, 'left');
    await expect(system.pressCallback(adminTelegramId, callback)).resolves.toBe(
      undefined,
    );
    expect(
      await system.templateIsArchived(first.id, 'Изолированный шаблон'),
    ).toBe(false);
  });

  it('resumes persisted drafts after API recreation and excludes archived templates', async () => {
    const adminTelegramId = '880021';
    const group = await system.createConfiguredGroup(adminTelegramId);
    await system.sendPrivateCommand(adminTelegramId, '/templates');
    await system.pressPrivateButton(adminTelegramId, 'Создать шаблон');
    await system.sendPrivateText(adminTelegramId, 'Возобновляемый шаблон');

    expect(await system.recreateTelegramApi()).toBe(true);
    await system.sendPrivateCommand(adminTelegramId, '/templates');
    expect(system.latestPrivateMessage(adminTelegramId).buttons).toEqual(
      expect.arrayContaining(['Продолжить', 'Начать заново']),
    );
    await system.pressPrivateButton(adminTelegramId, 'Продолжить');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      '<b>Место</b>',
    );

    await system.completeCurrentTemplateThroughTelegram(adminTelegramId, {
      venue: 'Зал после рестарта',
      capacity: 6,
    });
    await system.sendPrivateCommand(adminTelegramId, '/templates');
    await system.pressPrivateButton(adminTelegramId, 'Возобновляемый шаблон');
    const archive = system.latestPrivateButton(adminTelegramId, 'В архив');
    expect(archive).toMatch(/\.0$/);
    await system.pressCallback(adminTelegramId, archive);
    expect(
      await system.templateIsArchived(group.id, 'Возобновляемый шаблон'),
    ).toBe(false);
    expect(system.latestPrivateMessage(adminTelegramId).buttons).toContain(
      'Да, архивировать',
    );
    await system.pressPrivateButton(adminTelegramId, 'Да, архивировать');
    expect(
      await system.templateIsArchived(group.id, 'Возобновляемый шаблон'),
    ).toBe(true);
    await system.sendPrivateCommand(adminTelegramId, '/newgame');
    expect(system.latestPrivateMessage(adminTelegramId).text).not.toContain(
      'Возобновляемый шаблон',
    );
  });

  it('switches persisted text ownership both ways without deleting either draft', async () => {
    const adminTelegramId = '880022';
    await system.createConfiguredGroup(adminTelegramId);
    await system.createTemplateThroughTelegram(adminTelegramId, {
      name: 'Основа игры',
      venue: 'Основной зал',
      capacity: 8,
    });

    await system.sendPrivateCommand(adminTelegramId, '/templates');
    await system.pressPrivateButton(adminTelegramId, 'Создать шаблон');
    await system.sendPrivateText(adminTelegramId, 'Сохранённый черновик');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      '<b>Место</b>',
    );

    await system.sendPrivateCommand(adminTelegramId, '/newgame');
    await system.pressPrivateButton(adminTelegramId, 'Основа игры');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      '<b>Дата игры</b>',
    );

    await system.sendPrivateCommand(adminTelegramId, '/templates');
    await system.pressPrivateButton(adminTelegramId, 'Продолжить');
    expect(await system.recreateTelegramApi()).toBe(true);
    await system.sendPrivateText(adminTelegramId, 'Зал после переключения');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      '<b>Адрес</b>',
    );

    await system.sendPrivateCommand(adminTelegramId, '/newgame');
    await system.pressPrivateButton(adminTelegramId, 'Продолжить');
    await system.sendPrivateText(adminTelegramId, '10.09.2026');
    expect(system.latestPrivateMessage(adminTelegramId).text).toContain(
      'Настройки игры',
    );

    await system.sendPrivateCommand(adminTelegramId, '/templates');
    expect(system.latestPrivateMessage(adminTelegramId).buttons).toEqual(
      expect.arrayContaining(['Продолжить', 'Начать заново']),
    );
  });

  it('deduplicates duplicate publication and material notices and recovers canonical cards', async () => {
    const adminTelegramId = '880031';
    const memberTelegramId = '880032';
    await system.createConfiguredGroup(adminTelegramId);
    await system.createTemplateThroughTelegram(adminTelegramId, {
      name: 'Надёжная игра',
      venue: 'Первый зал',
      capacity: 5,
    });
    const game = await system.createAndPublishGameThroughTelegram(
      adminTelegramId,
      'Надёжная игра',
      { duplicatePublish: true },
    );
    expect(await system.gameCount(game.groupId)).toBe(1);

    await system.deliverLatestCanonicalCard(game.id!, { pinFails: true });
    expect(await system.canonicalPinFailed(game.id!)).toBe(true);
    const initialCard = await system.canonicalMessages(game.id!);
    expect(initialCard).toHaveLength(1);

    await system.deleteCanonicalCard(game.id!);
    await system.deliverLatestCanonicalCard(game.id!);
    const afterDeletedCard = await system.canonicalMessages(game.id!);
    expect(afterDeletedCard).toHaveLength(1);
    expect(afterDeletedCard).not.toEqual(initialCard);
    expect(await system.canonicalPinFailed(game.id!)).toBe(false);

    await system.deliverLatestCanonicalCard(game.id!, { uneditable: true });
    const afterUneditableCard = await system.canonicalMessages(game.id!);
    expect(afterUneditableCard).toHaveLength(1);
    expect(afterUneditableCard).not.toEqual(afterDeletedCard);
    expect(system.canonicalSendCount(game.id!)).toBe(3);
    await system.runScheduledOpening(game.groupId, game.id!);
    await system.deliverLatestCanonicalCard(game.id!);
    expect(
      system
        .generatedCallbacks()
        .some((callback) => callback.startsWith('v1:go:')),
    ).toBe(true);
    const registration = await system.pressGoingThroughTelegram(
      memberTelegramId,
      game.groupId,
      game.id!,
    );
    const delivery = await system.editVenueAndDeliverThroughTelegram(
      adminTelegramId,
      game.id!,
      'Второй <зал> & двор',
    );
    expect(
      await system.notificationDeliveryCount(
        delivery.deterministicJobId,
        registration,
      ),
    ).toBe(1);
    const materialMessages = system
      .privateMessageTexts(memberTelegramId)
      .filter((text) => text.includes('изменена:'));
    expect(materialMessages).toHaveLength(1);
    expect(materialMessages[0]).toContain('Стало:');
    expect(materialMessages[0]).toContain('Второй &lt;зал&gt; &amp; двор');

    await system.cancelThroughTelegram(adminTelegramId, game.id!);
    const cancellation = await system.deliverCancellationThroughWorkers(
      game.id!,
    );
    expect(
      await system.notificationDeliveryCount(
        cancellation.deterministicJobId,
        registration,
      ),
    ).toBe(1);
    const cancellationMessages = system
      .privateMessageTexts(memberTelegramId)
      .filter((text) => text.includes('отменена.'));
    expect(cancellationMessages).toEqual(['Игра «Надёжная игра» отменена.']);
    expect(await system.getGame(game.groupId, game.id!)).toMatchObject({
      state: 'CANCELLED',
    });
  });

  it('handles waitlisting, withdrawal, and guest registration through Telegram updates', async () => {
    const adminTelegramId = '880051';
    const rosteredTelegramId = '880052';
    const waitlistedTelegramId = '880053';
    await system.createConfiguredGroup(adminTelegramId);
    await system.createTemplateThroughTelegram(adminTelegramId, {
      name: 'Малая игра',
      venue: 'Корт',
      capacity: 1,
    });
    const game = await system.createAndPublishGameThroughTelegram(
      adminTelegramId,
      'Малая игра',
    );
    await system.deliverLatestCanonicalCard(game.id!);
    await system.runScheduledOpening(game.groupId, game.id!);
    await system.deliverLatestCanonicalCard(game.id!);

    const rostered = await system.pressGoingThroughTelegram(
      rosteredTelegramId,
      game.groupId,
      game.id!,
    );
    const waitlisted = await system.pressGoingThroughTelegram(
      waitlistedTelegramId,
      game.groupId,
      game.id!,
    );
    expect(await system.registrationState(rostered)).toBe('ROSTERED');
    expect(await system.registrationState(waitlisted)).toBe('WAITLISTED');
    await system.deliverLatestCanonicalCard(game.id!);
    expect(system.canonicalMessageText(game.id!)).toContain('Резерв: 1');

    await system.withdrawThroughTelegram(
      waitlistedTelegramId,
      game.groupId,
      game.id!,
    );
    expect(await system.registrationState(waitlisted)).toBe('CANCELLED');
    await system.withdrawThroughTelegram(
      waitlistedTelegramId,
      game.groupId,
      game.id!,
    );
    await system.deliverLatestCanonicalCard(game.id!);
    expect(system.canonicalMessageText(game.id!)).toContain('Резерв: 0');

    const guest = await system.addGuestThroughTelegram(
      rosteredTelegramId,
      game.groupId,
      game.id!,
      'Гость <Иван>',
    );
    expect(await system.registrationState(guest)).toBe('WAITLISTED');
    await system.deliverLatestCanonicalCard(game.id!);
    expect(system.canonicalMessageText(game.id!)).toContain('Резерв: 1');
    expect(system.canonicalMessageText(game.id!)).toContain(
      'Гость &lt;Иван&gt;',
    );
    expect(system.callbackAnswerTexts()).toEqual(
      expect.arrayContaining([
        'Вы в составе. Место: 1.',
        'Вы в резерве. Позиция: 1.',
        'Вы снялись с игры.',
        'Вы не записаны на эту игру.',
        'Откройте личный чат с ботом.',
      ]),
    );
    expect(system.callbackAnswerTexts().join('\n')).not.toMatch(
      /(?:registration|attendance|payment):/,
    );
  });

  it('lets only one concurrent administrator edit win', async () => {
    const firstAdmin = '880041';
    const secondAdmin = '880042';
    const group = await system.createConfiguredGroup(firstAdmin);
    await system.createTemplateThroughTelegram(firstAdmin, {
      name: 'Совместная игра',
      venue: 'Исходный зал',
      capacity: 8,
    });
    const game = await system.createAndPublishGameThroughTelegram(
      firstAdmin,
      'Совместная игра',
    );

    const result = await system.concurrentVenueEditsThroughTelegram({
      groupId: group.id,
      gameId: game.id!,
      firstAdmin,
      secondAdmin,
    });

    expect(['Зал A', 'Зал B']).toContain(result.venue);
    expect(result.revision).toBe(game.revision + 1);
  });
});
