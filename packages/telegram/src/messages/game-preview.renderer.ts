import type { GameTemplateSnapshot } from '@volley/domain';

export interface GamePreviewModel {
  /** Kept for compatibility and publication provenance; never rendered. */
  source: string;
  startsAtIso: string;
  settings?: GameTemplateSnapshot;
  timeZone?: string;
  now?: Date;
}

export const renderGamePreview = (model: GamePreviewModel): string => {
  const settings = model.settings;
  if (settings === undefined) return 'Проверьте дату и настройки игры.';
  const startsAt = new Date(model.startsAtIso);
  if (!Number.isFinite(startsAt.getTime()))
    throw new Error('Invalid game preview start');
  const timeZone = model.timeZone ?? 'UTC';
  const now = model.now ?? new Date();
  const registrationOpensAt = minutesBefore(
    startsAt,
    settings.registrationOpensMinutesBefore,
  );
  const registrationClosesAt =
    settings.registrationClosesMinutesBefore === null
      ? null
      : minutesBefore(startsAt, settings.registrationClosesMinutesBefore);
  const confirmationAt = minutesBefore(
    startsAt,
    settings.tentativePromptMinutesBefore,
  );
  const reminderAt = minutesBefore(startsAt, settings.reminderMinutesBefore);

  return [
    `<b>${escapeHtml(settings.name)}</b>`,
    `Место: ${escapeHtml(settings.venue)}`,
    `Адрес: ${settings.address === null ? 'не указан' : escapeHtml(settings.address)}`,
    `Дата и время: ${formatLocal(startsAt, timeZone)}`,
    `Длительность: ${settings.durationMinutes} мин`,
    `Мест: ${settings.capacity}`,
    registrationOpensAt.getTime() <= now.getTime()
      ? 'Регистрация откроется сразу'
      : `Регистрация откроется: ${formatLocal(registrationOpensAt, timeZone)}`,
    registrationClosesAt === null
      ? 'Регистрация не закрывается заранее'
      : `Регистрация закроется: ${formatLocal(registrationClosesAt, timeZone)}`,
    `Запрос подтверждения: ${formatLocal(confirmationAt, timeZone)}`,
    `Время на ответ: ${settings.tentativeResponseMinutes} мин`,
    `Напоминание: ${formatLocal(reminderAt, timeZone)}`,
    `Приоритет участников группы: ${settings.memberPriorityEnabled ? 'да' : 'нет'}`,
    `Стоимость: ${formatCost(settings.defaultTotalCostMinor)}`,
    `Округление: ${roundingLabel(settings.roundingMode)}`,
  ].join('\n');
};

const minutesBefore = (date: Date, minutes: number): Date =>
  new Date(date.getTime() - minutes * 60_000);

const formatLocal = (date: Date, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}.${parts.month}.${parts.year} в ${parts.hour}:${parts.minute}`;
};

const formatCost = (minor: bigint | null): string =>
  minor === null
    ? 'не указана'
    : `${minor / 100n},${(minor % 100n).toString().padStart(2, '0')} ₽`;

const roundingLabel = (
  rounding: GameTemplateSnapshot['roundingMode'],
): string =>
  ({
    EXACT: 'точно до копеек',
    UP_1: 'до 1 ₽ вверх',
    UP_10: 'до 10 ₽ вверх',
    UP_50: 'до 50 ₽ вверх',
  })[rounding];

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
