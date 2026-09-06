export type LocalDateTimeResolutionCode =
  | 'INVALID_DATE'
  | 'INVALID_TIME'
  | 'INVALID_TIME_ZONE'
  | 'NONEXISTENT'
  | 'AMBIGUOUS';

export class LocalDateTimeResolutionError extends Error {
  public constructor(public readonly code: LocalDateTimeResolutionCode) {
    super(
      (
        {
          INVALID_DATE: 'Invalid local date',
          INVALID_TIME: 'Invalid local time',
          INVALID_TIME_ZONE: 'Invalid time zone',
          NONEXISTENT: 'Local date and time does not exist',
          AMBIGUOUS: 'Local date and time is ambiguous',
        } as const
      )[code],
    );
    this.name = 'LocalDateTimeResolutionError';
  }
}

export interface LocalDateTimeInput {
  /** ISO calendar date produced by parseLocalDate. */
  date: string;
  /** Twenty-four-hour local time produced by parseLocalTime. */
  time: string;
  timeZone: string;
}

interface LocalComponents {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export const localDateTimeToInstant = (input: LocalDateTimeInput): Date => {
  const wanted = parseComponents(input.date, input.time);
  const formatter = createFormatter(input.timeZone);
  const localAsUtc = Date.UTC(
    wanted.year,
    wanted.month - 1,
    wanted.day,
    wanted.hour,
    wanted.minute,
  );

  // Start with the offset at the UTC-shaped local value, adjust it into an
  // instant, then inspect both sides of a possible offset transition.
  const candidateOffset = offsetAt(formatter, localAsUtc);
  const adjustedCandidate = localAsUtc - candidateOffset;
  const offsets = new Set<number>([
    candidateOffset,
    offsetAt(formatter, adjustedCandidate),
    offsetAt(formatter, adjustedCandidate - 36 * 60 * 60_000),
    offsetAt(formatter, adjustedCandidate + 36 * 60 * 60_000),
  ]);
  const matches = [...offsets]
    .map((offset) => localAsUtc - offset)
    .filter((instant, index, values) => values.indexOf(instant) === index)
    .filter((instant) => sameComponents(partsAt(formatter, instant), wanted));

  if (matches.length === 0)
    throw new LocalDateTimeResolutionError('NONEXISTENT');
  if (matches.length > 1) throw new LocalDateTimeResolutionError('AMBIGUOUS');
  return new Date(matches[0]!);
};

const parseComponents = (date: string, time: string): LocalComponents => {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (dateMatch === null)
    throw new LocalDateTimeResolutionError('INVALID_DATE');
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (timeMatch === null)
    throw new LocalDateTimeResolutionError('INVALID_TIME');
  const wanted = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  const calendarCheck = new Date(
    Date.UTC(wanted.year, wanted.month - 1, wanted.day),
  );
  if (
    calendarCheck.getUTCFullYear() !== wanted.year ||
    calendarCheck.getUTCMonth() + 1 !== wanted.month ||
    calendarCheck.getUTCDate() !== wanted.day
  ) {
    throw new LocalDateTimeResolutionError('INVALID_DATE');
  }
  if (wanted.hour > 23 || wanted.minute > 59)
    throw new LocalDateTimeResolutionError('INVALID_TIME');
  return wanted;
};

const createFormatter = (timeZone: string): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new LocalDateTimeResolutionError('INVALID_TIME_ZONE');
  }
};

const partsAt = (
  formatter: Intl.DateTimeFormat,
  instant: number,
): LocalComponents => {
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
  };
};

const offsetAt = (formatter: Intl.DateTimeFormat, instant: number): number => {
  const local = partsAt(formatter, instant);
  return (
    Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
    instant
  );
};

const sameComponents = (
  actual: LocalComponents,
  expected: LocalComponents,
): boolean =>
  actual.year === expected.year &&
  actual.month === expected.month &&
  actual.day === expected.day &&
  actual.hour === expected.hour &&
  actual.minute === expected.minute;
