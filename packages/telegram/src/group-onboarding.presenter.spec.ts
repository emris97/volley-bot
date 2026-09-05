import { asGroupId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  renderConfiguredSummary,
  renderStartError,
  renderWizardView,
} from './group-onboarding.presenter.js';
import type { WizardProgress } from './group-onboarding.model.js';

const groupId = asGroupId('00000000-0000-4000-8000-000000000001');

describe('group onboarding presenter', () => {
  it.each([
    [{}, 'Шаг 1 из 7', ['Астрахань (UTC+4)']],
    [
      { tz: 'Europe/Astrakhan' },
      'Шаг 2 из 7',
      ['Участники группы выше гостей', 'В порядке записи'],
    ],
    [
      { tz: 'Europe/Astrakhan', mp: true },
      'Шаг 3 из 7',
      ['За 24 часа', 'За 12 часов', 'За 6 часов'],
    ],
    [
      { tz: 'Europe/Astrakhan', mp: true, tp: 1440 },
      'Шаг 4 из 7',
      ['30 минут', '1 час', '2 часа'],
    ],
    [
      { tz: 'Europe/Astrakhan', mp: true, tp: 1440, tr: 60 },
      'Шаг 5 из 7',
      ['За 30 минут', 'За 1 час', 'За 2 часа'],
    ],
    [
      { tz: 'Europe/Astrakhan', mp: true, tp: 1440, tr: 60, rm: 120 },
      'Шаг 6 из 7',
      ['Точно до копеек', 'Вверх до 1 ₽', 'Вверх до 10 ₽', 'Вверх до 50 ₽'],
    ],
    [
      {
        tz: 'Europe/Astrakhan',
        mp: true,
        tp: 1440,
        tr: 60,
        rm: 120,
        ro: 'UP_10',
      },
      'Шаг 7 из 7',
      ['Да', 'Нет'],
    ],
  ] as Array<[WizardProgress, string, string[]]>)(
    'renders the authoritative step for progress %#',
    (progress, heading, labels) => {
      const view = renderWizardView(groupId, progress);
      expect(view.text).toContain(heading);
      expect(view.keyboard.flat().map(({ text }) => text)).toEqual(labels);
      expect(
        view.keyboard
          .flat()
          .every(({ callbackData }) => Buffer.byteLength(callbackData) <= 64),
      ).toBe(true);
    },
  );

  it('renders the complete draft with explicit save and reset actions', () => {
    const view = renderWizardView(groupId, completeProgress());
    expect(view.text).toContain('Проверьте настройки');
    expect(view.text).toContain('Астрахань (UTC+4)');
    expect(view.text).toContain('Вверх до 10 ₽');
    expect(view.keyboard.flat().map(({ text }) => text)).toEqual([
      '✅ Сохранить настройки',
      '🔄 Начать заново',
    ]);
  });

  it('renders saved settings without onboarding actions and escapes unknown zones', () => {
    const view = renderConfiguredSummary({
      timeZone: '<Other/Zone>',
      memberPriorityEnabled: false,
      tentativePromptMinutesBefore: 720,
      tentativeResponseMinutes: 30,
      reminderMinutesBefore: 60,
      currency: 'RUB',
      roundingMode: 'EXACT',
      pinGameMessages: false,
    });
    expect(view.text).toContain('Группа уже настроена');
    expect(view.text).toContain('&lt;Other/Zone&gt;');
    expect(view.text).not.toContain('<Other/Zone>');
    expect(view.keyboard).toEqual([]);
  });

  it('renders safe Russian explanations for every expected start error', () => {
    expect(renderStartError('BARE_START').text).toContain('ссылку');
    expect(renderStartError('INVALID_LINK').text).toContain('недействительна');
    expect(renderStartError('EXPIRED_LINK').text).toContain('истёк');
    expect(renderStartError('FOREIGN_LINK').text).toContain(
      'другого администратора',
    );
    expect(renderStartError('ADMIN_REQUIRED').text).toContain(
      'права администратора',
    );
  });
});

const completeProgress = (): Required<WizardProgress> => ({
  tz: 'Europe/Astrakhan',
  mp: true,
  tp: 1440,
  tr: 60,
  rm: 120,
  ro: 'UP_10',
  pin: true,
});
