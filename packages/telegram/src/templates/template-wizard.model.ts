import {
  asGameTemplateId,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type UserId,
} from '@volley/domain';
import {
  isTemplateWizardStep,
  type TemplateWizardStep,
} from '../organizer/settings-editor.model.js';

export type TemplateWizardMode = 'CREATE' | 'EDIT' | 'COPY';

export interface TemplateWizardDraft {
  version: 1;
  mode: TemplateWizardMode;
  step: TemplateWizardStep;
  draftId: string;
  viewRevision: number;
  templateId?: GameTemplateId;
  expectedRevision?: number;
  snapshot: Partial<GameTemplateSnapshot>;
  previewed: boolean;
}

export interface TemplateWizardDraftStore {
  load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<TemplateWizardDraft | null>;
  save(
    groupId: GroupId,
    actorUserId: UserId,
    draft: TemplateWizardDraft,
  ): Promise<void>;
  clear(groupId: GroupId, actorUserId: UserId): Promise<void>;
}

const stepCodes: Record<TemplateWizardStep, string> = {
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
  PREVIEW: 'w',
};
const stepsByCode = new Map(
  Object.entries(stepCodes).map(([step, code]) => [
    code,
    step as TemplateWizardStep,
  ]),
);

export const templateDraftControlId = (draft: TemplateWizardDraft): string =>
  `${draft.draftId}.${stepCodes[draft.step]}.${draft.viewRevision.toString(36)}`;

export const parseTemplateDraftControlId = (
  value: string | undefined,
): {
  draftId: string;
  step: TemplateWizardStep;
  viewRevision: number;
} | null => {
  const [draftId, stepCode, revisionCode, ...rest] = value?.split('.') ?? [];
  const step = stepsByCode.get(stepCode ?? '');
  const viewRevision = Number.parseInt(revisionCode ?? '', 36);
  return rest.length > 0 ||
    draftId === undefined ||
    !/^[0-9a-f]{32}$/.test(draftId) ||
    step === undefined ||
    !/^(?:0|[1-9a-z][0-9a-z]*)$/.test(revisionCode ?? '') ||
    !Number.isSafeInteger(viewRevision) ||
    viewRevision < 0 ||
    viewRevision > 2_147_483_647 ||
    viewRevision.toString(36) !== revisionCode
    ? null
    : { draftId, step, viewRevision };
};

const draftKeys = new Set([
  'version',
  'mode',
  'step',
  'draftId',
  'viewRevision',
  'templateId',
  'expectedRevision',
  'snapshot',
  'previewed',
]);
const snapshotKeys = new Set<keyof GameTemplateSnapshot>([
  'name',
  'venue',
  'address',
  'startsAtLocalTime',
  'durationMinutes',
  'capacity',
  'registrationOpensMinutesBefore',
  'registrationClosesMinutesBefore',
  'tentativePromptMinutesBefore',
  'tentativeResponseMinutes',
  'reminderMinutesBefore',
  'memberPriorityEnabled',
  'defaultTotalCostMinor',
  'currency',
  'roundingMode',
]);

export const parseTemplateWizardDraft = (
  value: Record<string, unknown>,
): TemplateWizardDraft => {
  for (const key of Object.keys(value)) {
    if (!draftKeys.has(key)) throw new Error(`Unknown draft key: ${key}`);
  }
  if (value.version !== 1) throw new Error('Unsupported draft version');
  if (!isMode(value.mode)) throw new Error('Invalid draft mode');
  if (!isTemplateWizardStep(value.step)) throw new Error('Invalid draft step');
  if (
    typeof value.draftId !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(value.draftId)
  ) {
    throw new Error('Invalid draft id');
  }
  const viewRevision =
    value.viewRevision === undefined ? 0 : value.viewRevision;
  if (
    !Number.isSafeInteger(viewRevision) ||
    Number(viewRevision) < 0 ||
    Number(viewRevision) > 2_147_483_647
  ) {
    throw new Error('Invalid draft view revision');
  }
  if (typeof value.previewed !== 'boolean') {
    throw new Error('Invalid draft preview state');
  }
  const snapshot = parseSnapshot(value.snapshot);
  if (
    value.templateId !== undefined &&
    (typeof value.templateId !== 'string' || !isUuid(value.templateId))
  ) {
    throw new Error('Invalid template id');
  }
  if (
    value.expectedRevision !== undefined &&
    (!Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 1)
  ) {
    throw new Error('Invalid expected revision');
  }
  if (
    value.mode === 'EDIT' &&
    (value.templateId === undefined || value.expectedRevision === undefined)
  ) {
    throw new Error('Edit draft requires a template revision');
  }

  return {
    version: 1,
    mode: value.mode,
    step: value.step,
    draftId: value.draftId,
    viewRevision: viewRevision as number,
    ...(value.templateId === undefined
      ? {}
      : { templateId: asGameTemplateId(value.templateId as string) }),
    ...(value.expectedRevision === undefined
      ? {}
      : { expectedRevision: value.expectedRevision as number }),
    snapshot,
    previewed: value.previewed,
  };
};

const parseSnapshot = (value: unknown): Partial<GameTemplateSnapshot> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid draft snapshot');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!snapshotKeys.has(key as keyof GameTemplateSnapshot)) {
      throw new Error(`Unknown snapshot key: ${key}`);
    }
  }
  const revived = { ...record };
  if (typeof revived.defaultTotalCostMinor === 'string') {
    if (!/^bigint:\d+$/.test(revived.defaultTotalCostMinor)) {
      throw new Error('Invalid draft bigint');
    }
    revived.defaultTotalCostMinor = BigInt(
      revived.defaultTotalCostMinor.slice(7),
    );
  }
  validateSnapshotTypes(revived);
  return revived as Partial<GameTemplateSnapshot>;
};

const validateSnapshotTypes = (snapshot: Record<string, unknown>): void => {
  const stringKeys = ['name', 'venue', 'startsAtLocalTime'] as const;
  const numberKeys = [
    'durationMinutes',
    'capacity',
    'registrationOpensMinutesBefore',
    'tentativePromptMinutesBefore',
    'tentativeResponseMinutes',
    'reminderMinutesBefore',
  ] as const;
  for (const key of stringKeys) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string')
      throw new Error(`Invalid snapshot ${key}`);
  }
  for (const key of numberKeys) {
    if (snapshot[key] !== undefined && !Number.isSafeInteger(snapshot[key]))
      throw new Error(`Invalid snapshot ${key}`);
  }
  if (
    snapshot.address !== undefined &&
    snapshot.address !== null &&
    typeof snapshot.address !== 'string'
  )
    throw new Error('Invalid snapshot address');
  if (
    snapshot.registrationClosesMinutesBefore !== undefined &&
    snapshot.registrationClosesMinutesBefore !== null &&
    !Number.isSafeInteger(snapshot.registrationClosesMinutesBefore)
  )
    throw new Error('Invalid snapshot closing');
  if (
    snapshot.memberPriorityEnabled !== undefined &&
    typeof snapshot.memberPriorityEnabled !== 'boolean'
  )
    throw new Error('Invalid snapshot priority');
  if (
    snapshot.defaultTotalCostMinor !== undefined &&
    snapshot.defaultTotalCostMinor !== null &&
    typeof snapshot.defaultTotalCostMinor !== 'bigint'
  )
    throw new Error('Invalid snapshot cost');
  if (snapshot.currency !== undefined && snapshot.currency !== 'RUB')
    throw new Error('Invalid snapshot currency');
  if (
    snapshot.roundingMode !== undefined &&
    !['EXACT', 'UP_1', 'UP_10', 'UP_50'].includes(
      snapshot.roundingMode as string,
    )
  )
    throw new Error('Invalid snapshot rounding');
};

const isMode = (value: unknown): value is TemplateWizardMode =>
  value === 'CREATE' || value === 'EDIT' || value === 'COPY';

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
