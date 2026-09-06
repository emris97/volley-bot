import { describe, expect, it } from 'vitest';
import { localDateTimeToInstant } from './local-date-time.js';

describe('localDateTimeToInstant', () => {
  it('converts an unambiguous local date and time through the IANA zone', () => {
    expect(
      localDateTimeToInstant({
        date: '2026-09-10',
        time: '19:00',
        timeZone: 'Europe/Astrakhan',
      }).toISOString(),
    ).toBe('2026-09-10T15:00:00.000Z');
  });

  it('rejects a nonexistent local time at a daylight-saving transition', () => {
    expect(() =>
      localDateTimeToInstant({
        date: '2026-03-29',
        time: '02:30',
        timeZone: 'Europe/Berlin',
      }),
    ).toThrow(/does not exist/i);
  });

  it('rejects an ambiguous local time at a daylight-saving transition', () => {
    expect(() =>
      localDateTimeToInstant({
        date: '2026-10-25',
        time: '02:30',
        timeZone: 'Europe/Berlin',
      }),
    ).toThrow(/ambiguous/i);
  });

  it('rejects invalid local components and time-zone identifiers', () => {
    expect(() =>
      localDateTimeToInstant({
        date: '2026-02-30',
        time: '19:00',
        timeZone: 'Europe/Astrakhan',
      }),
    ).toThrow(/invalid local date/i);
    expect(() =>
      localDateTimeToInstant({
        date: '2026-09-10',
        time: '19:00',
        timeZone: 'Not/AZone',
      }),
    ).toThrow(/invalid time zone/i);
  });
});
