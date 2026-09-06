import type { NotificationIntent } from '@volley/application';

export const renderNotification = (
  intent: NotificationIntent,
): { text: string; buttons: NotificationIntent['buttons'] } => ({
  text:
    intent.recipient.kind === 'GUEST'
      ? `${escapeHtml(intent.recipient.displayName)}: ${escapeHtml(intent.text)}`
      : escapeHtml(intent.text),
  buttons: intent.buttons,
});

export interface GameChangeNotificationInput {
  name: string;
  timeZone: string;
  before: {
    startsAt: Date;
    venue: string;
    address: string | null;
  };
  after: {
    startsAt: Date;
    venue: string;
    address: string | null;
  };
}

export const gameChangedNotificationText = (
  input: GameChangeNotificationInput,
): string =>
  [
    `Игра «${input.name}» изменена:`,
    `Было: ${gameLocation(input.before, input.timeZone)}`,
    `Стало: ${gameLocation(input.after, input.timeZone)}`,
  ].join('\n');

export const gameCancelledNotificationText = (name: string): string =>
  `Игра «${name}» отменена.`;

const gameLocation = (
  input: GameChangeNotificationInput['before'],
  timeZone: string,
): string =>
  `${formatLocalDateTime(input.startsAt, timeZone)} — ${input.venue}${
    input.address === null ? '' : ` — ${input.address}`
  }`;

const formatLocalDateTime = (value: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')}, ${part('hour')}:${part('minute')}`;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
