import { describe, expect, it } from 'vitest';
import { asGameId, asGroupId, asTelegramId } from '@volley/domain';
import type { GameMessageView } from './game-message.model.js';
import { renderGameMessage } from './game-message.renderer.js';

describe('renderGameMessage', () => {
  it('renders roster, waitlist, and tentative counts from one view model', () => {
    const rendered = renderGameMessage(
      view({
        capacity: 14,
        roster: Array.from({ length: 12 }, (_, index) => `Игрок ${index + 1}`),
        waitlist: ['Запасной 1', 'Запасной 2', 'Запасной 3'],
        tentative: ['Не уверен 1', 'Не уверен 2'],
      }),
    );

    expect(rendered.text).toContain('Состав: 12/14');
    expect(rendered.text).toContain('Резерв: 3');
    expect(rendered.text).toContain('Не уверены: 2');
    expect(rendered.keyboard.flat().map((button) => button.text)).toEqual([
      'Иду',
      'Не уверен',
      'Добавить гостя',
      'Управление',
    ]);
  });

  it('escapes all user-controlled HTML', () => {
    const rendered = renderGameMessage(
      view({
        name: '<b>Friday & friends</b>',
        venue: 'A < B',
        roster: ['<Admin>'],
      }),
    );

    expect(rendered.text).toContain('&lt;b&gt;Friday &amp; friends&lt;/b&gt;');
    expect(rendered.text).toContain('A &lt; B');
    expect(rendered.text).toContain('&lt;Admin&gt;');
  });

  it('advertises only the compact revision-bound management callback', () => {
    const rendered = renderGameMessage(view({ revision: 35 }));
    const manage = rendered.keyboard
      .flat()
      .find(({ text }) => text === 'Управление');

    expect(manage?.callbackData).toBe('ga:v1:manage:AY9roGLSe9GPExLgyEJGEA:z');
    expect(manage?.callbackData).not.toContain(
      '018f6ba0-62d2-7bd1-8f13-12e0c8424610',
    );
    expect(Buffer.byteLength(manage?.callbackData ?? '', 'utf8')).toBeLessThan(
      64,
    );
  });

  it('keeps canonical pin failures out of the public game card', () => {
    const rendered = renderGameMessage(
      view({ canonicalPinFailedAt: new Date('2026-09-01T12:00:00.000Z') }),
    );

    expect(rendered.text).not.toContain('закреп');
    expect(rendered.text).not.toContain('ошиб');
  });
});

const view = (overrides: Partial<GameMessageView> = {}): GameMessageView => ({
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  gameId: asGameId('018f6ba0-62d2-7bd1-8f13-12e0c8424610'),
  telegramChatId: asTelegramId('-1001000000001'),
  canonicalMessageId: 99n,
  canonicalPinFailedAt: null,
  pinMessage: true,
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAt: new Date('2026-09-04T16:00:00.000Z'),
  timeZone: 'Europe/Astrakhan',
  state: 'OPEN',
  revision: 4,
  capacity: 14,
  roster: [],
  waitlist: [],
  tentative: [],
  ...overrides,
});
