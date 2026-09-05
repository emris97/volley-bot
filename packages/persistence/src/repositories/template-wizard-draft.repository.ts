import {
  asGameTemplateId,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { templateWizardDrafts } from '../schema/index.js';

export type StoredTemplateWizardStep =
  | 'NAME'
  | 'VENUE'
  | 'ADDRESS'
  | 'TIME'
  | 'DURATION'
  | 'CAPACITY'
  | 'OPENING'
  | 'CLOSING'
  | 'CONFIRMATION_PROMPT'
  | 'CONFIRMATION_RESPONSE'
  | 'REMINDER'
  | 'MEMBER_PRIORITY'
  | 'COST'
  | 'ROUNDING'
  | 'PREVIEW';

export interface StoredTemplateWizardDraft {
  version: 1;
  mode: 'CREATE' | 'EDIT' | 'COPY';
  step: StoredTemplateWizardStep;
  draftId: string;
  templateId?: GameTemplateId;
  expectedRevision?: number;
  snapshot: Partial<GameTemplateSnapshot>;
  previewed: boolean;
}

export class TemplateWizardDraftRepository {
  public constructor(private readonly database: Database) {}

  public async load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<StoredTemplateWizardDraft | null> {
    const [row] = await this.database
      .select()
      .from(templateWizardDrafts)
      .where(
        and(
          eq(templateWizardDrafts.groupId, groupId),
          eq(templateWizardDrafts.actorUserId, actorUserId),
        ),
      )
      .limit(1);
    return row === undefined ? null : parseStoredDraft(revive(row.data));
  }

  public async save(
    groupId: GroupId,
    actorUserId: UserId,
    draft: StoredTemplateWizardDraft,
  ): Promise<void> {
    const data = serialize(draft);
    await this.database
      .insert(templateWizardDrafts)
      .values({ groupId, actorUserId, data })
      .onConflictDoUpdate({
        target: [
          templateWizardDrafts.groupId,
          templateWizardDrafts.actorUserId,
        ],
        set: { data, updatedAt: new Date() },
      });
  }

  public async clear(groupId: GroupId, actorUserId: UserId): Promise<void> {
    await this.database
      .delete(templateWizardDrafts)
      .where(
        and(
          eq(templateWizardDrafts.groupId, groupId),
          eq(templateWizardDrafts.actorUserId, actorUserId),
        ),
      );
  }
}

const draftKeys = new Set([
  'version',
  'mode',
  'step',
  'draftId',
  'templateId',
  'expectedRevision',
  'snapshot',
  'previewed',
]);
const snapshotKeys = new Set([
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
const steps = new Set<StoredTemplateWizardStep>([
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
  'PREVIEW',
]);

const parseStoredDraft = (
  value: Record<string, unknown>,
): StoredTemplateWizardDraft => {
  rejectUnknownKeys(value, draftKeys, 'draft');
  if (value.version !== 1) throw new Error('Unsupported draft version');
  if (!['CREATE', 'EDIT', 'COPY'].includes(value.mode as string))
    throw new Error('Invalid draft mode');
  if (!steps.has(value.step as StoredTemplateWizardStep))
    throw new Error('Invalid draft step');
  if (
    typeof value.draftId !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(value.draftId)
  )
    throw new Error('Invalid draft id');
  if (typeof value.previewed !== 'boolean')
    throw new Error('Invalid preview state');
  if (typeof value.snapshot !== 'object' || value.snapshot === null)
    throw new Error('Invalid draft snapshot');
  const snapshot = value.snapshot as Record<string, unknown>;
  rejectUnknownKeys(snapshot, snapshotKeys, 'snapshot');
  validateSnapshot(snapshot);
  if (
    value.templateId !== undefined &&
    (typeof value.templateId !== 'string' || !isUuid(value.templateId))
  )
    throw new Error('Invalid template id');
  if (
    value.expectedRevision !== undefined &&
    (!Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 1)
  )
    throw new Error('Invalid expected revision');
  if (
    value.mode === 'EDIT' &&
    (value.templateId === undefined || value.expectedRevision === undefined)
  )
    throw new Error('Edit draft requires a template revision');

  return {
    version: 1,
    mode: value.mode as StoredTemplateWizardDraft['mode'],
    step: value.step as StoredTemplateWizardStep,
    draftId: value.draftId,
    ...(value.templateId === undefined
      ? {}
      : { templateId: asGameTemplateId(value.templateId as string) }),
    ...(value.expectedRevision === undefined
      ? {}
      : { expectedRevision: value.expectedRevision as number }),
    snapshot: snapshot as Partial<GameTemplateSnapshot>,
    previewed: value.previewed,
  };
};

const validateSnapshot = (snapshot: Record<string, unknown>): void => {
  for (const key of ['name', 'venue', 'startsAtLocalTime']) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string')
      throw new Error(`Invalid snapshot ${key}`);
  }
  for (const key of [
    'durationMinutes',
    'capacity',
    'registrationOpensMinutesBefore',
    'tentativePromptMinutesBefore',
    'tentativeResponseMinutes',
    'reminderMinutesBefore',
  ]) {
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
    throw new Error('Invalid draft bigint');
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

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${label} key: ${key}`);
  }
};

const serialize = (value: StoredTemplateWizardDraft): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? `bigint:${item}` : item,
    ),
  ) as Record<string, unknown>;

const revive = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item === 'string' && /^bigint:\d+$/.test(item))
      return BigInt(item.slice(7));
    return item;
  }) as Record<string, unknown>;

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
