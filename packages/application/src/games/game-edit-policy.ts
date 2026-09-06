import type { Game, GameState } from '@volley/domain';

export type GameEditableField =
  | 'name'
  | 'venue'
  | 'address'
  | 'startsAt'
  | 'durationMinutes'
  | 'capacity'
  | 'registrationOpensAt'
  | 'registrationClosesAt'
  | 'tentativePromptAt'
  | 'tentativeResponseDeadline'
  | 'reminderAt'
  | 'memberPriorityEnabled'
  | 'totalCostMinor'
  | 'currency'
  | 'roundingMode';

export type GameUpdateChanges = Partial<Pick<Game, GameEditableField>>;
export type MaterialGameField = 'startsAt' | 'venue' | 'address';

const allFields: readonly GameEditableField[] = [
  'name',
  'venue',
  'address',
  'startsAt',
  'durationMinutes',
  'capacity',
  'registrationOpensAt',
  'registrationClosesAt',
  'tentativePromptAt',
  'tentativeResponseDeadline',
  'reminderAt',
  'memberPriorityEnabled',
  'totalCostMinor',
  'currency',
  'roundingMode',
];

const openAfterRegistration = allFields.filter(
  (field) =>
    field !== 'registrationOpensAt' && field !== 'memberPriorityEnabled',
);

const closedFields: readonly GameEditableField[] = [
  'name',
  'venue',
  'address',
  'startsAt',
  'durationMinutes',
  'capacity',
  'totalCostMinor',
  'currency',
  'roundingMode',
];

export const editableFields = (input: {
  state: GameState;
  registrationCount: number;
}): readonly GameEditableField[] => {
  if (input.state === 'DRAFT' || input.state === 'SCHEDULED') {
    return allFields;
  }
  if (input.state === 'OPEN') {
    return input.registrationCount === 0 ? allFields : openAfterRegistration;
  }
  if (input.state === 'CLOSED') return closedFields;
  return [];
};

export class GameRevisionConflictError extends Error {
  public constructor() {
    super('Игра уже была изменена. Откройте актуальную версию.');
    this.name = 'GameRevisionConflictError';
  }
}

export class GameEditNotAllowedError extends Error {
  public constructor() {
    super('Это поле нельзя изменить в текущем состоянии игры.');
    this.name = 'GameEditNotAllowedError';
  }
}

export const assertGameEditAllowed = (
  input: { state: GameState; registrationCount: number },
  changes: GameUpdateChanges,
): void => {
  const allowed = new Set(editableFields(input));
  if (
    (Object.keys(changes) as GameEditableField[]).some(
      (field) => !allowed.has(field),
    )
  ) {
    throw new GameEditNotAllowedError();
  }
};

const MAX_COST_MINOR = 100_000_000n;
const validRoundingModes = new Set(['EXACT', 'UP_1', 'UP_10', 'UP_50']);

export const normalizeGameChanges = (
  changes: GameUpdateChanges,
  now = new Date(),
): GameUpdateChanges => {
  for (const field of Object.keys(changes) as GameEditableField[]) {
    if (!allFields.includes(field)) throw new GameEditNotAllowedError();
  }
  const normalized = Object.fromEntries(
    Object.entries(changes).filter(([, value]) => value !== undefined),
  ) as GameUpdateChanges;
  if (changes.name !== undefined) {
    normalized.name = normalizedText(changes.name, 1, 80, 'название');
  }
  if (changes.venue !== undefined) {
    normalized.venue = normalizedText(changes.venue, 1, 120, 'место');
  }
  if (changes.address !== undefined) {
    const address = changes.address?.trim() ?? null;
    if (address !== null && Array.from(address).length > 300) {
      throw new Error('Адрес должен содержать не более 300 символов.');
    }
    normalized.address = address === '' ? null : address;
  }
  if (changes.durationMinutes !== undefined) {
    assertInteger(changes.durationMinutes, 15, 720, 'Длительность');
  }
  if (changes.capacity !== undefined) {
    assertInteger(changes.capacity, 1, 200, 'Количество мест');
  }
  if (
    changes.totalCostMinor !== undefined &&
    changes.totalCostMinor !== null &&
    (changes.totalCostMinor < 0n || changes.totalCostMinor > MAX_COST_MINOR)
  ) {
    throw new Error('Стоимость должна быть от 0 до 1 000 000 рублей.');
  }
  if (changes.currency !== undefined && changes.currency !== 'RUB') {
    throw new Error('Поддерживается только валюта RUB.');
  }
  if (
    changes.roundingMode !== undefined &&
    !validRoundingModes.has(changes.roundingMode)
  ) {
    throw new Error('Некорректное округление стоимости.');
  }
  if (
    changes.memberPriorityEnabled !== undefined &&
    typeof changes.memberPriorityEnabled !== 'boolean'
  ) {
    throw new Error('Некорректная настройка приоритета.');
  }
  for (const field of dateFields) {
    const value = changes[field];
    if (value !== undefined && value !== null) {
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error('Некорректная дата или время игры.');
      }
      normalized[field] = new Date(value) as never;
    }
  }
  if (
    changes.startsAt !== undefined &&
    changes.startsAt.getTime() <= now.getTime()
  ) {
    throw new Error('Время начала игры должно быть в будущем.');
  }
  return normalized;
};

export const validateGameTiming = (
  game: Pick<
    Game,
    | 'startsAt'
    | 'registrationOpensAt'
    | 'registrationClosesAt'
    | 'tentativePromptAt'
    | 'tentativeResponseDeadline'
    | 'reminderAt'
  >,
): void => {
  const start = game.startsAt.getTime();
  const opens = game.registrationOpensAt.getTime();
  const closes = game.registrationClosesAt?.getTime() ?? null;
  const prompt = game.tentativePromptAt.getTime();
  const deadline = game.tentativeResponseDeadline.getTime();
  const reminder = game.reminderAt.getTime();
  if (
    opens > start ||
    (closes !== null && (closes < opens || closes > start)) ||
    prompt > deadline ||
    deadline > start ||
    reminder > start
  ) {
    throw new Error('Проверьте порядок времени игры и уведомлений.');
  }
};

export const changedMaterialFields = (
  before: Game,
  after: Game,
): readonly MaterialGameField[] =>
  (['startsAt', 'venue', 'address'] as const).filter((field) =>
    field === 'startsAt'
      ? before.startsAt.getTime() !== after.startsAt.getTime()
      : before[field] !== after[field],
  );

export const scheduleAffectingFields: readonly GameEditableField[] = [
  'startsAt',
  'registrationOpensAt',
  'registrationClosesAt',
  'tentativePromptAt',
  'tentativeResponseDeadline',
  'reminderAt',
];

const dateFields = [
  'startsAt',
  'registrationOpensAt',
  'registrationClosesAt',
  'tentativePromptAt',
  'tentativeResponseDeadline',
  'reminderAt',
] as const;

const normalizedText = (
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): string => {
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum) {
    throw new Error(`Некорректное поле: ${label}.`);
  }
  return normalized;
};

const assertInteger = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${label}: допустимо целое число от ${minimum} до ${maximum}.`,
    );
  }
};
