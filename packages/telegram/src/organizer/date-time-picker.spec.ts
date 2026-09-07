import { describe, expect, it } from 'vitest';
import {
  renderCalendarKeyboard,
  renderHourKeyboard,
  renderMinuteKeyboard,
} from './date-time-picker.js';

describe('inline date and time picker', () => {
  it('renders a Monday-first month and disables dates before today', () => {
    const keyboard = renderCalendarKeyboard({
      month: '2026-09',
      minDate: '2026-09-07',
      callbackData: (action, value) => `${action}:${value}`,
    });

    expect(keyboard[0]?.map(({ text }) => text)).toEqual(['Сентябрь 2026']);
    expect(keyboard[1]?.map(({ text }) => text)).toEqual([
      'Пн',
      'Вт',
      'Ср',
      'Чт',
      'Пт',
      'Сб',
      'Вс',
    ]);
    expect(keyboard.flat().find(({ text }) => text === '6')?.callbackData).toBe(
      'noop:202609',
    );
    expect(
      keyboard.flat().find(({ text }) => text === '10')?.callbackData,
    ).toBe('date:20260910');
    expect(keyboard.at(-1)?.map(({ text }) => text)).toEqual([
      '‹ Август',
      'Октябрь ›',
    ]);
  });

  it('renders hours followed by quarter-hour choices', () => {
    expect(renderHourKeyboard((hour) => `hour:${hour}`).flat()).toContainEqual({
      text: '19',
      callbackData: 'hour:19',
    });
    expect(
      renderMinuteKeyboard(19, (time) => `time:${time}`)[0]?.map(
        ({ text }) => text,
      ),
    ).toEqual(['19:00', '19:15', '19:30', '19:45']);
  });
});
