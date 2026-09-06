import { describe, expect, it } from 'vitest';
import {
  parseInteger,
  parseLocalDate,
  parseLocalTime,
  parseRubles,
  parseUnicodeText,
} from './input.parsers.js';

describe('organizer input parsers', () => {
  it('parses real local dates in ДД.ММ.ГГГГ format', () => {
    expect(parseLocalDate('29.02.2028')).toBe('2028-02-29');
    expect(parseLocalDate('31.02.2028')).toEqual({ error: 'DATE' });
    expect(parseLocalDate('2028-02-29')).toEqual({ error: 'DATE' });
  });

  it('parses local time in ЧЧ:ММ format', () => {
    expect(parseLocalTime('19:30')).toBe('19:30');
    expect(parseLocalTime('24:00')).toEqual({ error: 'TIME' });
    expect(parseLocalTime('7:05')).toEqual({ error: 'TIME' });
  });

  it('accepts only decimal integers in the configured inclusive range', () => {
    expect(parseInteger('15', 15, 720, 'DURATION_RANGE')).toBe(15);
    expect(parseInteger('720', 15, 720, 'DURATION_RANGE')).toBe(720);
    expect(parseInteger('14', 15, 720, 'DURATION_RANGE')).toEqual({
      error: 'DURATION_RANGE',
    });
    expect(parseInteger('15.5', 15, 720, 'DURATION_RANGE')).toEqual({
      error: 'DURATION_RANGE',
    });
  });

  it('converts rubles with dot or comma kopecks and enforces the cost range', () => {
    expect(parseRubles('1250,50')).toBe(125050n);
    expect(parseRubles('0.01')).toBe(1n);
    expect(parseRubles('1000000')).toBe(100000000n);
    expect(parseRubles('1000000.01')).toEqual({ error: 'COST_RANGE' });
    expect(parseRubles('12.345')).toEqual({ error: 'COST_FORMAT' });
  });

  it('counts Unicode code points after trimming at accepted boundaries', () => {
    expect(
      parseUnicodeText(`  ${'🏐'.repeat(80)}  `, 1, 80, 'NAME_LENGTH'),
    ).toBe('🏐'.repeat(80));
    expect(parseUnicodeText('🏐'.repeat(81), 1, 80, 'NAME_LENGTH')).toEqual({
      error: 'NAME_LENGTH',
    });
    expect(parseUnicodeText('З'.repeat(120), 1, 120, 'VENUE_LENGTH')).toBe(
      'З'.repeat(120),
    );
    expect(parseUnicodeText('А'.repeat(300), 0, 300, 'ADDRESS_LENGTH')).toBe(
      'А'.repeat(300),
    );
  });
});
