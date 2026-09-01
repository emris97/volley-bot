import { CallbackCodec } from '../callbacks/callback-codec.js';
import type {
  GameMessageView,
  RenderedTelegramMessage,
  TelegramButton,
} from './game-message.model.js';

const codec = new CallbackCodec();

export const renderGameMessage = (
  view: GameMessageView,
): RenderedTelegramMessage => {
  const lines = [
    `<b>${escapeHtml(view.name)}</b>`,
    `📍 ${escapeHtml(view.venue)}${view.address === null ? '' : ` — ${escapeHtml(view.address)}`}`,
    `🗓 ${formatStartsAt(view.startsAt, view.timeZone)}`,
    `Статус: ${stateLabel(view.state)}`,
    '',
    `Состав: ${view.roster.length}/${view.capacity}`,
    ...names(view.roster),
    `Резерв: ${view.waitlist.length}`,
    ...names(view.waitlist),
    `Не уверены: ${view.tentative.length}`,
    ...names(view.tentative),
  ];
  return {
    text: lines.join('\n'),
    parseMode: 'HTML',
    keyboard: keyboardFor(view),
  };
};

const keyboardFor = (
  view: GameMessageView,
): readonly (readonly TelegramButton[])[] => {
  const button = (text: string, callbackData: string): TelegramButton => ({
    text,
    callbackData,
  });
  if (view.state !== 'OPEN') {
    return [
      [
        button(
          'Управление',
          codec.encode({ version: 1, action: 'MANAGE', gameId: view.gameId }),
        ),
      ],
    ];
  }
  return [
    [
      button('Иду', codec.going(view.gameId)),
      button('Не уверен', codec.tentative(view.gameId)),
    ],
    [button('Добавить гостя', codec.addGuest(view.gameId))],
    [
      button(
        'Управление',
        codec.encode({ version: 1, action: 'MANAGE', gameId: view.gameId }),
      ),
    ],
  ];
};

const names = (items: readonly string[]): string[] =>
  items.map((name, index) => `${index + 1}. ${escapeHtml(name)}`);

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const formatStartsAt = (value: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);

const stateLabel = (state: GameMessageView['state']): string =>
  ({
    DRAFT: 'черновик',
    SCHEDULED: 'запланирована',
    OPEN: 'регистрация открыта',
    CLOSED: 'регистрация закрыта',
    COMPLETED: 'завершена',
    CANCELLED: 'отменена',
  })[state];
