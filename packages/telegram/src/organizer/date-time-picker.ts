export interface PickerButton {
  text: string;
  callbackData: string;
}

type PickerKeyboard = PickerButton[][];

const weekDays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const monthNames = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

export const renderCalendarKeyboard = (input: {
  month: string;
  minDate: string;
  callbackData: (action: 'date' | 'month' | 'noop', value: string) => string;
}): PickerKeyboard => {
  const { year, month } = parseMonth(input.month);
  const compactMonth = `${year}${pad(month)}`;
  const firstWeekDay =
    (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: PickerButton[] = Array.from({ length: firstWeekDay }, () => ({
    text: ' ',
    callbackData: input.callbackData('noop', compactMonth),
  }));
  for (let day = 1; day <= days; day += 1) {
    const date = `${year}-${pad(month)}-${pad(day)}`;
    cells.push({
      text: day.toString(),
      callbackData: input.callbackData(
        date < input.minDate ? 'noop' : 'date',
        date < input.minDate ? compactMonth : date.replaceAll('-', ''),
      ),
    });
  }
  while (cells.length % 7 !== 0) {
    cells.push({
      text: ' ',
      callbackData: input.callbackData('noop', compactMonth),
    });
  }
  const previous = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  return [
    [
      {
        text: `${monthNames[month - 1]} ${year}`,
        callbackData: input.callbackData('noop', compactMonth),
      },
    ],
    weekDays.map((text) => ({
      text,
      callbackData: input.callbackData('noop', compactMonth),
    })),
    ...chunk(cells, 7),
    [
      {
        text: `‹ ${monthNames[previous.month - 1]}`,
        callbackData: input.callbackData('month', previous.value),
      },
      {
        text: `${monthNames[next.month - 1]} ›`,
        callbackData: input.callbackData('month', next.value),
      },
    ],
  ];
};

export const renderHourKeyboard = (
  callbackData: (hour: string) => string,
): PickerKeyboard =>
  chunk(
    Array.from({ length: 16 }, (_, index) =>
      (index + 8).toString().padStart(2, '0'),
    ).map((hour) => ({ text: hour, callbackData: callbackData(hour) })),
    4,
  );

export const renderMinuteKeyboard = (
  hour: number,
  callbackData: (time: string) => string,
): PickerKeyboard => [
  ['00', '15', '30', '45'].map((minute) => {
    const time = `${pad(hour)}:${minute}`;
    return { text: time, callbackData: callbackData(time) };
  }),
];

export const localIsoDate = (instant: Date, timeZone: string): string => {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
};

const parseMonth = (value: string): { year: number; month: number } => {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (match === null || month < 1 || month > 12)
    throw new Error('Invalid calendar month');
  return { year, month };
};

const shiftMonth = (
  year: number,
  month: number,
  offset: number,
): { year: number; month: number; value: string } => {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  const result = {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
  };
  return { ...result, value: `${result.year}-${pad(result.month)}` };
};

const pad = (value: number): string => value.toString().padStart(2, '0');

const chunk = <T>(values: readonly T[], size: number): T[][] => {
  const rows: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    rows.push(values.slice(index, index + size));
  return rows;
};
