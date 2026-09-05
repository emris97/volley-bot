export interface ParseError<Code extends string> {
  error: Code;
}

export const parseLocalDate = (input: string): string | ParseError<'DATE'> => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(input.trim());
  if (match === null) return { error: 'DATE' };
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
    ? iso
    : { error: 'DATE' };
};

export const parseLocalTime = (input: string): string | ParseError<'TIME'> => {
  const normalized = input.trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)
    ? normalized
    : { error: 'TIME' };
};

export const parseInteger = <Code extends string>(
  input: string,
  minimum: number,
  maximum: number,
  error: Code,
): number | ParseError<Code> => {
  const normalized = input.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) return { error };
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : { error };
};

export const parseRubles = (
  input: string,
): bigint | ParseError<'COST_FORMAT' | 'COST_RANGE'> => {
  const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (match === null) return { error: 'COST_FORMAT' };
  const rubles = BigInt(match[1]!);
  const kopecks = BigInt((match[2] ?? '').padEnd(2, '0'));
  const value = rubles * 100n + kopecks;
  return value <= 100_000_000n ? value : { error: 'COST_RANGE' };
};

export const parseUnicodeText = <Code extends string>(
  input: string,
  minimum: number,
  maximum: number,
  error: Code,
): string | ParseError<Code> => {
  const normalized = input.trim();
  const length = Array.from(normalized).length;
  return length >= minimum && length <= maximum ? normalized : { error };
};
