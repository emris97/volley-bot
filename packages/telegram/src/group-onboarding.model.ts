import { asGroupId, type GroupId } from '@volley/domain';

export type WizardCode = 'tz' | 'mp' | 'tp' | 'tr' | 'rm' | 'ro' | 'pin';

export type WizardProgress = Partial<{
  tz: 'Europe/Astrakhan';
  mp: boolean;
  tp: 1440 | 720 | 360;
  tr: 30 | 60 | 120;
  rm: 30 | 60 | 120;
  ro: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pin: boolean;
}>;

export type CompleteWizardProgress = Required<WizardProgress>;

export type WizardAnswer =
  | { code: 'tz'; value: 'Europe/Astrakhan' }
  | { code: 'mp'; value: boolean }
  | { code: 'tp'; value: 1440 | 720 | 360 }
  | { code: 'tr'; value: 30 | 60 | 120 }
  | { code: 'rm'; value: 30 | 60 | 120 }
  | { code: 'ro'; value: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50' }
  | { code: 'pin'; value: boolean };

export type OnboardingCallback =
  | { kind: 'ANSWER'; groupId: GroupId; answer: WizardAnswer }
  | { kind: 'SAVE'; groupId: GroupId }
  | { kind: 'RESET'; groupId: GroupId };

export type OnboardingInputErrorCode =
  | 'INVALID_CALLBACK'
  | 'INVALID_LINK'
  | 'FOREIGN_LINK'
  | 'ADMIN_REQUIRED';

export class OnboardingInputError extends Error {
  public constructor(public readonly code: OnboardingInputErrorCode) {
    super(code);
    this.name = 'OnboardingInputError';
  }
}

export const wizardOrder = [
  'tz',
  'mp',
  'tp',
  'tr',
  'rm',
  'ro',
  'pin',
] as const satisfies readonly WizardCode[];

const allowedValues = {
  tz: ['Europe/Astrakhan'],
  mp: [true, false],
  tp: [1440, 720, 360],
  tr: [30, 60, 120],
  rm: [30, 60, 120],
  ro: ['EXACT', 'UP_1', 'UP_10', 'UP_50'],
  pin: [true, false],
} as const;

export const parseWizardProgress = (value: unknown): WizardProgress => {
  if (!isRecord(value)) throw invalidStoredProgress();
  const result: Record<string, unknown> = {};
  for (const [rawCode, rawValue] of Object.entries(value)) {
    if (!wizardOrder.includes(rawCode as WizardCode)) {
      throw invalidStoredProgress();
    }
    const code = rawCode as WizardCode;
    if (!(allowedValues[code] as readonly unknown[]).includes(rawValue)) {
      throw invalidStoredProgress();
    }
    result[code] = rawValue;
  }
  return result as WizardProgress;
};

export const nextWizardCode = (
  progress: WizardProgress,
): WizardCode | undefined =>
  wizardOrder.find((code) => progress[code] === undefined);

export const encodeAnswerCallback = (
  groupId: GroupId,
  answer: WizardAnswer,
): string =>
  `cfg:${groupId}:${answer.code}:${typeof answer.value === 'boolean' ? (answer.value ? '1' : '0') : answer.value}`;

export const encodeActionCallback = (
  groupId: GroupId,
  action: 'SAVE' | 'RESET',
): string => `cfg:${groupId}:${action.toLowerCase()}:1`;

export const parseOnboardingCallback = (value: string): OnboardingCallback => {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== 'cfg') throw invalidCallback();
  const [, rawGroupId, rawCode, rawValue] = parts;
  if (
    rawGroupId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      rawGroupId,
    ) ||
    rawCode === undefined ||
    rawValue === undefined
  ) {
    throw invalidCallback();
  }
  const groupId = asGroupId(rawGroupId);
  if (rawCode === 'save' || rawCode === 'reset') {
    if (rawValue !== '1') throw invalidCallback();
    return { kind: rawCode === 'save' ? 'SAVE' : 'RESET', groupId };
  }
  const answer = parseAnswer(rawCode, rawValue);
  return { kind: 'ANSWER', groupId, answer };
};

const parseAnswer = (rawCode: string, rawValue: string): WizardAnswer => {
  switch (rawCode) {
    case 'tz':
      if (rawValue === 'Europe/Astrakhan') {
        return { code: 'tz', value: rawValue };
      }
      break;
    case 'mp':
    case 'pin':
      if (rawValue === '0' || rawValue === '1') {
        return { code: rawCode, value: rawValue === '1' };
      }
      break;
    case 'tp':
      if (rawValue === '1440' || rawValue === '720' || rawValue === '360') {
        return { code: rawCode, value: Number(rawValue) as 1440 | 720 | 360 };
      }
      break;
    case 'tr':
    case 'rm':
      if (rawValue === '30' || rawValue === '60' || rawValue === '120') {
        return { code: rawCode, value: Number(rawValue) as 30 | 60 | 120 };
      }
      break;
    case 'ro':
      if (
        rawValue === 'EXACT' ||
        rawValue === 'UP_1' ||
        rawValue === 'UP_10' ||
        rawValue === 'UP_50'
      ) {
        return { code: rawCode, value: rawValue };
      }
      break;
  }
  throw invalidCallback();
};

const invalidCallback = (): OnboardingInputError =>
  new OnboardingInputError('INVALID_CALLBACK');

const invalidStoredProgress = (): Error =>
  new Error('Invalid stored onboarding progress');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
