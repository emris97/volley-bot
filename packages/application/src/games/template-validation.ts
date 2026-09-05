import type { GameTemplateSnapshot } from '@volley/domain';
import {
  TemplateInputError,
  type TemplateInputErrorCode,
} from './template-errors.js';

const MAX_COST_MINOR = 100_000_000n;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const validateTemplateSnapshot = (
  snapshot: GameTemplateSnapshot,
): GameTemplateSnapshot => {
  const name = validateText(snapshot.name, 'NAME', 1, 80);
  const venue = validateText(snapshot.venue, 'VENUE', 1, 120);
  const trimmedAddress = snapshot.address?.trim() ?? null;
  if (trimmedAddress !== null && Array.from(trimmedAddress).length > 300) {
    throw new TemplateInputError('ADDRESS');
  }
  if (!LOCAL_TIME.test(snapshot.startsAtLocalTime)) {
    throw new TemplateInputError('TIME');
  }
  validateInteger(snapshot.durationMinutes, 'DURATION', 15, 720);
  validateInteger(snapshot.capacity, 'CAPACITY', 1, 200);
  validateOffset(snapshot.registrationOpensMinutesBefore, 'OPENING');
  if (snapshot.registrationClosesMinutesBefore !== null) {
    validateOffset(snapshot.registrationClosesMinutesBefore, 'CLOSING');
    if (
      snapshot.registrationClosesMinutesBefore >
      snapshot.registrationOpensMinutesBefore
    ) {
      throw new TemplateInputError('CLOSING');
    }
  }
  validateOffset(snapshot.tentativePromptMinutesBefore, 'CONFIRMATION');
  validateOffset(snapshot.tentativeResponseMinutes, 'CONFIRMATION');
  if (
    snapshot.tentativeResponseMinutes > snapshot.tentativePromptMinutesBefore
  ) {
    throw new TemplateInputError('CONFIRMATION');
  }
  validateOffset(snapshot.reminderMinutesBefore, 'REMINDER');
  if (
    snapshot.defaultTotalCostMinor !== null &&
    (snapshot.defaultTotalCostMinor < 0n ||
      snapshot.defaultTotalCostMinor > MAX_COST_MINOR)
  ) {
    throw new TemplateInputError('COST');
  }

  return {
    ...snapshot,
    name,
    venue,
    address: trimmedAddress === '' ? null : trimmedAddress,
  };
};

const validateText = (
  value: string,
  code: Extract<TemplateInputErrorCode, 'NAME' | 'VENUE'>,
  minimum: number,
  maximum: number,
): string => {
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum) {
    throw new TemplateInputError(code);
  }
  return normalized;
};

const validateInteger = (
  value: number,
  code: TemplateInputErrorCode,
  minimum: number,
  maximum: number,
): void => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TemplateInputError(code);
  }
};

const validateOffset = (
  value: number,
  code: Extract<
    TemplateInputErrorCode,
    'OPENING' | 'CLOSING' | 'CONFIRMATION' | 'REMINDER'
  >,
): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TemplateInputError(code);
  }
};
