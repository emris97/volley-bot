import type {
  GameCreationDraft,
  GameCreationDraftEditField,
  GameCreationDraftStep,
} from '@volley/application';
import type { SettingsEditorField } from '../organizer/settings-editor.model.js';

const stepCodes: Record<GameCreationDraftStep, string> = {
  TEMPLATE: 't',
  DATE: 'd',
  CUSTOMIZE: 'c',
  PREVIEW: 'p',
  PUBLISHED: 'u',
};
const stepsByCode = new Map(
  Object.entries(stepCodes).map(([step, code]) => [
    code,
    step as GameCreationDraftStep,
  ]),
);

export const gameEditorFields = [
  'NAME',
  'VENUE',
  'ADDRESS',
  'TIME',
  'DURATION',
  'CAPACITY',
  'OPENING',
  'CLOSING',
  'CONFIRMATION_PROMPT',
  'CONFIRMATION_RESPONSE',
  'REMINDER',
  'MEMBER_PRIORITY',
  'COST',
  'ROUNDING',
] as const satisfies readonly SettingsEditorField[] &
  readonly GameCreationDraftEditField[];

const fieldCodes: Record<SettingsEditorField, string> = {
  NAME: 'n',
  VENUE: 'v',
  ADDRESS: 'a',
  TIME: 't',
  DURATION: 'd',
  CAPACITY: 'c',
  OPENING: 'o',
  CLOSING: 'x',
  CONFIRMATION_PROMPT: 'p',
  CONFIRMATION_RESPONSE: 'q',
  REMINDER: 'r',
  MEMBER_PRIORITY: 'm',
  COST: 'k',
  ROUNDING: 'g',
};
const fieldsByCode = new Map(
  Object.entries(fieldCodes).map(([field, code]) => [
    code,
    field as SettingsEditorField,
  ]),
);

export interface GameDraftControl {
  draftId: string;
  step: GameCreationDraftStep;
  viewRevision: number;
}

export const currentGameDraftViewRevision = (
  draft: GameCreationDraft,
): number => draft.viewRevision ?? 0;

export const gameDraftControlId = (draft: GameCreationDraft): string =>
  [
    compactGameUuid(draft.draftId),
    stepCodes[draft.step],
    currentGameDraftViewRevision(draft).toString(36),
  ].join('.');

export const parseGameDraftControlId = (
  value: string | undefined,
): GameDraftControl | null => {
  const [compactDraftId, stepCode, revisionCode, ...rest] =
    value?.split('.') ?? [];
  const step = stepsByCode.get(stepCode ?? '');
  const viewRevision = Number.parseInt(revisionCode ?? '', 36);
  if (
    rest.length > 0 ||
    compactDraftId === undefined ||
    step === undefined ||
    !/^[0-9a-z]+$/.test(revisionCode ?? '') ||
    !Number.isSafeInteger(viewRevision) ||
    viewRevision < 0 ||
    viewRevision > 2_147_483_647
  ) {
    return null;
  }
  try {
    return {
      draftId: expandGameCompactUuid(compactDraftId).replaceAll('-', ''),
      step,
      viewRevision,
    };
  } catch {
    return null;
  }
};

export const nextGameDraftView = (
  draft: GameCreationDraft,
): GameCreationDraft => {
  const current = currentGameDraftViewRevision(draft);
  if (current >= 2_147_483_647)
    throw new Error('Game creation view revision exhausted');
  return { ...draft, viewRevision: current + 1 };
};

export const gameFieldCode = (field: SettingsEditorField): string =>
  fieldCodes[field];

export const parseGameFieldCode = (
  value: string | undefined,
): SettingsEditorField | null => fieldsByCode.get(value ?? '') ?? null;

export const compactGameUuid = (value: string): string => {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid UUID');
  return Buffer.from(hex, 'hex').toString('base64url');
};

export const expandGameCompactUuid = (value: string): string => {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value))
    throw new Error('Invalid compact UUID');
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) throw new Error('Invalid compact UUID');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const sameGameDraftControl = (
  draft: GameCreationDraft,
  control: GameDraftControl | null,
): boolean =>
  control !== null &&
  control.draftId === draft.draftId &&
  control.step === draft.step &&
  control.viewRevision === currentGameDraftViewRevision(draft);
