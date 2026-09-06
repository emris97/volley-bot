import { asGameTemplateId, type GameTemplateSnapshot } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { renderGamePreview } from '../messages/game-preview.renderer.js';
import {
  gameCreationCallback,
  renderGameTemplateChoice,
} from './game-creation.presenter.js';

const settings: GameTemplateSnapshot = {
  name: 'Среда вечером',
  venue: 'Зал № 1',
  address: 'ул. Мира, 1',
  startsAtLocalTime: '19:00',
  durationMinutes: 120,
  capacity: 18,
  registrationOpensMinutesBefore: 0,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: 125_050n,
  currency: 'RUB',
  roundingMode: 'UP_10',
};

describe('game creation presenter', () => {
  it('renders every required preview field in the group local time without identifiers', () => {
    const gameId = '40000000-0000-4000-8000-000000000001';
    const scheduled = {
      source: gameId,
      startsAtIso: '2026-09-10T15:00:00.000Z',
      settings,
      timeZone: 'Europe/Astrakhan',
      now: new Date('2026-09-09T12:00:00.000Z'),
    };

    const rendered = renderGamePreview(scheduled);

    expect(rendered).toContain('Среда вечером');
    expect(rendered).toContain('Зал № 1');
    expect(rendered).toContain('ул. Мира, 1');
    expect(rendered).toContain('10.09.2026 в 19:00');
    expect(rendered).toContain('Длительность: 120 мин');
    expect(rendered).toContain('Мест: 18');
    expect(rendered).toContain('Регистрация откроется: 10.09.2026 в 19:00');
    expect(rendered).toContain('Регистрация закроется: 10.09.2026 в 18:00');
    expect(rendered).toContain('Запрос подтверждения: 09.09.2026 в 19:00');
    expect(rendered).toContain('Время на ответ: 60 мин');
    expect(rendered).toContain('Напоминание: 10.09.2026 в 17:00');
    expect(rendered).toContain('Приоритет участников группы: да');
    expect(rendered).toContain('Стоимость: 1250,50 ₽');
    expect(rendered).toContain('Округление: до 10 ₽ вверх');
    expect(JSON.stringify(rendered)).not.toContain(gameId);
  });

  it('distinguishes registration that opens immediately', () => {
    const openNow = {
      source: 'scratch',
      startsAtIso: '2026-09-10T15:00:00.000Z',
      settings: {
        ...settings,
        address: null,
        registrationOpensMinutesBefore: 1_440,
      },
      timeZone: 'Europe/Astrakhan',
      now: new Date('2026-09-10T14:00:00.000Z'),
    };

    expect(renderGamePreview(openNow)).toContain('Адрес: не указан');
    expect(renderGamePreview(openNow)).toContain('Регистрация откроется сразу');
  });

  it('uses versioned compact callbacks below Telegram limit and hides raw UUIDs', () => {
    const templateId = asGameTemplateId('30000000-0000-4000-8000-000000000001');
    const view = renderGameTemplateChoice({
      draft: {
        version: 1,
        draftId: '018f6ba062d27bd18f1312e0c8424611',
        groupId: '10000000-0000-4000-8000-000000000001' as never,
        actorUserId: '20000000-0000-4000-8000-000000000001' as never,
        step: 'TEMPLATE',
        viewRevision: 2,
        previewed: false,
      },
      templates: [
        {
          ...settings,
          id: templateId,
          groupId: '10000000-0000-4000-8000-000000000001' as never,
          revision: 1,
          archivedAt: null,
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ],
    });

    expect(view.text).not.toContain(templateId);
    expect(
      view.keyboard.flat().every(({ callbackData }) => {
        return (
          callbackData.startsWith('gc:v1:') &&
          Buffer.byteLength(callbackData, 'utf8') < 64
        );
      }),
    ).toBe(true);
    expect(() => gameCreationCallback('x'.repeat(64))).toThrow(/64 bytes/i);
  });
});
