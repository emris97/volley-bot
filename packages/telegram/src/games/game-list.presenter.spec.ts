import { asGameId, asGroupId, type Game, type GameState } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  gameActionCallback,
  parseGameActionCallback,
  renderGameActionConfirmation,
  renderGameList,
  renderGameManagement,
  type ManagementGameView,
} from './game-list.presenter.js';

const uuid = '10000000-0000-4000-8000-000000000001';

describe('game list presenter', () => {
  it('renders no more than eight games without visible UUIDs', () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      game({
        id: asGameId(
          `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ),
        name: `Игра ${index + 1}`,
        startsAt: new Date(Date.UTC(2026, 8, index + 10, 16)),
      }),
    );
    const view = renderGameList({
      bucket: 'UPCOMING',
      items,
      nextCursor: items[7]!.id!,
      timeZone: 'Europe/Astrakhan',
    });

    expect(view.keyboard.slice(0, 8)).toHaveLength(8);
    expect(view.text).toContain('Предстоящие игры');
    expect(
      JSON.stringify({
        text: view.text,
        labels: view.keyboard.flat().map(({ text }) => text),
      }),
    ).not.toMatch(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
    for (const button of view.keyboard.flat()) {
      expect(Buffer.byteLength(button.callbackData, 'utf8')).toBeLessThan(64);
    }
    expect(view.keyboard[0]![0]!.callbackData).toMatch(
      /^ga:v1:view:[A-Za-z0-9_-]{22}:0$/,
    );
    expect(view.keyboard[8]![0]!.callbackData).toMatch(
      /^ga:v1:next-u:[A-Za-z0-9_-]{22}:0$/,
    );
  });
});

describe('game management presenter', () => {
  it.each([
    ['DRAFT', ['Изменить', 'Опубликовать', 'Удалить черновик']],
    ['SCHEDULED', ['Изменить', 'Открыть регистрацию', 'Отменить игру']],
    ['OPEN', ['Изменить', 'Закрыть регистрацию', 'Отменить игру']],
    [
      'CLOSED',
      ['Открыть регистрацию снова', 'Завершить игру', 'Отменить игру'],
    ],
    ['COMPLETED', ['Посещаемость', 'Расчёт оплат', 'Итоги']],
    ['CANCELLED', []],
  ] satisfies Array<[GameState, string[]]>)(
    'renders only %s actions',
    (state, labels) => {
      const view = renderGameManagement(managementView(state));
      const actual = view.keyboard
        .flat()
        .filter(({ callbackData }) => callbackData.startsWith('ga:v1:'))
        .map(({ text }) => text);

      expect(actual).toEqual(labels);
      expect(view.text).not.toContain(uuid);
    },
  );

  it.each([
    ['publish', 'Опубликовать игру?'],
    ['delete', 'Удалить черновик?'],
    ['open', 'Открыть регистрацию?'],
    ['close', 'Закрыть регистрацию?'],
    ['reopen', 'Открыть регистрацию снова?'],
    ['complete', 'Завершить игру?'],
    ['cancel', 'Отменить игру?'],
  ] as const)('uses a separate confirmation for %s', (action, question) => {
    const view = renderGameActionConfirmation(managementView('OPEN'), action);

    expect(view.text).toContain(question);
    expect(view.keyboard[0]![0]!.callbackData).toBe(
      gameActionCallback(`${action}-confirm`, asGameId(uuid), 12),
    );
    expect(view.keyboard[1]![0]!.callbackData).toBe(
      gameActionCallback('view', asGameId(uuid), 12),
    );
  });

  it('round-trips strict versioned compact callbacks and rejects tampering', () => {
    const encoded = gameActionCallback('cancel-confirm', asGameId(uuid), 35);

    expect(encoded).toBe('ga:v1:cancel-confirm:EAAAAAAAQACAAAAAAAAAAQ:z');
    expect(parseGameActionCallback(encoded)).toEqual({
      action: 'cancel-confirm',
      gameId: asGameId(uuid),
      revision: 35,
    });
    for (const malformed of [
      encoded.replace('ga:v1:', 'ga:'),
      encoded.replace(':z', ':z!'),
      encoded.replace(':z', ':0z'),
      encoded.replace('EAAAAAAAQACAAAAAAAAAAQ', 'EAAAAAAAQACAAAAAAAAAAR'),
      encoded.replace('cancel-confirm', 'next-c'),
      encoded.replace('cancel-confirm', 'unknown'),
      `${encoded}:extra`,
    ]) {
      expect(() => parseGameActionCallback(malformed)).toThrow(
        'Некорректная кнопка управления игрой.',
      );
    }
  });
});

const managementView = (state: GameState): ManagementGameView => ({
  game: game({ state, revision: 12 }),
  registrationCount: 3,
  rosterCount: 2,
  waitlistCount: 1,
  hasFinalizedAttendance: true,
  canonicalPinFailedAt: null,
});

const game = (overrides: Partial<Game> = {}): Game => ({
  id: asGameId(uuid),
  groupId: asGroupId('20000000-0000-4000-8000-000000000001'),
  sourceTemplateId: null,
  name: 'Вечерняя игра',
  venue: 'Арена',
  address: null,
  startsAt: new Date('2026-09-10T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 12,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-09-01T16:00:00.000Z'),
  registrationClosesAt: new Date('2026-09-10T15:00:00.000Z'),
  tentativePromptAt: new Date('2026-09-09T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-09T17:00:00.000Z'),
  reminderAt: new Date('2026-09-10T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'SCHEDULED',
  revision: 0,
  scheduleRevision: 0,
  canonicalTelegramMessageId: 5n,
  ...overrides,
});
