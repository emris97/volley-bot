export interface Money {
  readonly amountMinor: bigint;
  readonly currency: 'RUB';
}

const DECIMAL_RUBLES = /^\d+(?:\.\d{1,2})?$/;

/** Parse ruble text without converting the monetary value through number. */
export function rubles(value: string): Money {
  if (typeof value !== 'string') {
    throw new Error('Money amount must be a string');
  }
  if (!DECIMAL_RUBLES.test(value)) {
    throw new Error(
      'Money amount must be a nonnegative decimal string with at most two fractional digits',
    );
  }

  const separatorIndex = value.indexOf('.');
  const wholeText =
    separatorIndex === -1 ? value : value.slice(0, separatorIndex);
  const fractionalText =
    separatorIndex === -1 ? '' : value.slice(separatorIndex + 1);
  const amountMinor =
    BigInt(wholeText) * 100n + BigInt(fractionalText.padEnd(2, '0') || '0');
  return { amountMinor, currency: 'RUB' };
}
