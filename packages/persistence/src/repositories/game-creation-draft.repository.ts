import type {
  GameCreationDraft,
  GameCreationDraftExpectedView,
  GameCreationDraftMutationResult,
  GameCreationDraftStep,
} from '@volley/application';
import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asUserId,
  type GameTemplateSnapshot,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { gameCreationDrafts } from '../schema/index.js';

export type StoredGameCreationDraft = GameCreationDraft;

export class GameCreationDraftRepository {
  public constructor(private readonly database: Database) {}

  public async load(
    groupId: GroupId,
    actorUserId: UserId,
  ): Promise<GameCreationDraft | null> {
    const [row] = await this.database
      .select()
      .from(gameCreationDrafts)
      .where(
        and(
          eq(gameCreationDrafts.groupId, groupId),
          eq(gameCreationDrafts.actorUserId, actorUserId),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : parseGameCreationDraftData(
          row.data,
          asGroupId(row.groupId),
          asUserId(row.actorUserId),
        );
  }

  public async replaceForNewFlow(
    draft: GameCreationDraft,
    expected: GameCreationDraftExpectedView | null = null,
  ): Promise<GameCreationDraftMutationResult> {
    if (
      draft.step !== 'TEMPLATE' ||
      draft.previewed ||
      draft.editingField !== undefined ||
      draft.cancelPending === true ||
      draft.templateId !== undefined ||
      draft.snapshot !== undefined ||
      draft.startsAtIso !== undefined ||
      draft.publishedGameId !== undefined
    ) {
      throw new Error('New game creation draft must start at template choice');
    }
    const data = serializeGameCreationDraftData(draft);
    if (expected === null) {
      const [inserted] = await this.database
        .insert(gameCreationDrafts)
        .values({
          groupId: draft.groupId,
          actorUserId: draft.actorUserId,
          data,
        })
        .onConflictDoNothing()
        .returning({ groupId: gameCreationDrafts.groupId });
      return inserted === undefined ? 'STALE' : 'SAVED';
    }
    const [updated] = await this.database
      .update(gameCreationDrafts)
      .set({ data, updatedAt: new Date() })
      .where(
        and(
          eq(gameCreationDrafts.groupId, draft.groupId),
          eq(gameCreationDrafts.actorUserId, draft.actorUserId),
          sql`${gameCreationDrafts.data} ->> 'draftId' = ${expected.draftId}`,
          sql`${gameCreationDrafts.data} ->> 'step' = ${expected.step}`,
          sql`coalesce(${gameCreationDrafts.data} ->> 'viewRevision', '0') = ${expected.viewRevision.toString()}`,
        ),
      )
      .returning({ groupId: gameCreationDrafts.groupId });
    return updated === undefined ? 'STALE' : 'SAVED';
  }

  public async compareAndSet(
    draft: GameCreationDraft,
  ): Promise<GameCreationDraftMutationResult> {
    if (draft.step === 'PUBLISHED' || draft.publishedGameId !== undefined) {
      throw new Error('Published drafts can only be written by publication');
    }
    const [updated] = await this.database
      .update(gameCreationDrafts)
      .set({
        data: serializeGameCreationDraftData(draft),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gameCreationDrafts.groupId, draft.groupId),
          eq(gameCreationDrafts.actorUserId, draft.actorUserId),
          sql`${gameCreationDrafts.data} ->> 'draftId' = ${draft.draftId}`,
          sql`${gameCreationDrafts.data} ->> 'step' <> 'PUBLISHED'`,
          sql`${gameCreationDrafts.data} ->> 'publishedGameId' is null`,
          ...(draft.viewRevision === undefined
            ? []
            : [
                sql`coalesce(${gameCreationDrafts.data} ->> 'viewRevision', '0') = ${(draft.viewRevision - 1).toString()}`,
              ]),
        ),
      )
      .returning({ groupId: gameCreationDrafts.groupId });
    return updated === undefined ? 'STALE' : 'SAVED';
  }

  public async clear(
    groupId: GroupId,
    actorUserId: UserId,
    expected?: { draftId: string; viewRevision: number },
  ): Promise<boolean> {
    const [deleted] = await this.database
      .delete(gameCreationDrafts)
      .where(
        and(
          eq(gameCreationDrafts.groupId, groupId),
          eq(gameCreationDrafts.actorUserId, actorUserId),
          ...(expected === undefined
            ? []
            : [
                sql`${gameCreationDrafts.data} ->> 'draftId' = ${expected.draftId}`,
                sql`coalesce(${gameCreationDrafts.data} ->> 'viewRevision', '0') = ${expected.viewRevision.toString()}`,
                sql`${gameCreationDrafts.data} ->> 'step' <> 'PUBLISHED'`,
                sql`${gameCreationDrafts.data} ->> 'publishedGameId' is null`,
              ]),
        ),
      )
      .returning({ groupId: gameCreationDrafts.groupId });
    return deleted !== undefined;
  }
}

const draftKeys = new Set([
  'version',
  'draftId',
  'step',
  'viewRevision',
  'editingField',
  'cancelPending',
  'templateId',
  'snapshot',
  'startsAtIso',
  'previewed',
  'publishedGameId',
]);
const steps = new Set<GameCreationDraftStep>([
  'TEMPLATE',
  'DATE',
  'CUSTOMIZE',
  'PREVIEW',
  'PUBLISHED',
]);
const editingFields = new Set([
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
]);
const snapshotKeys = [
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
] as const satisfies readonly (keyof GameTemplateSnapshot)[];
const snapshotKeySet = new Set<string>(snapshotKeys);

export const parseGameCreationDraftData = (
  stored: unknown,
  groupId: GroupId,
  actorUserId: UserId,
): GameCreationDraft => {
  const value = revive(stored);
  if (!isRecord(value)) throw new Error('Invalid game creation draft');
  rejectUnknownKeys(value, draftKeys, 'draft');
  if (value.version !== 1) throw new Error('Unsupported draft version');
  if (
    typeof value.draftId !== 'string' ||
    !/^[0-9a-f]{32}$/i.test(value.draftId)
  ) {
    throw new Error('Invalid draft id');
  }
  if (!steps.has(value.step as GameCreationDraftStep)) {
    throw new Error('Invalid draft step');
  }
  if (typeof value.previewed !== 'boolean') {
    throw new Error('Invalid preview state');
  }
  if (
    value.viewRevision !== undefined &&
    (!Number.isSafeInteger(value.viewRevision) ||
      Number(value.viewRevision) < 0 ||
      Number(value.viewRevision) > 2_147_483_647)
  ) {
    throw new Error('Invalid game draft view revision');
  }
  if (
    value.editingField !== undefined &&
    (typeof value.editingField !== 'string' ||
      !editingFields.has(value.editingField))
  ) {
    throw new Error('Invalid game draft editor field');
  }
  if (
    value.cancelPending !== undefined &&
    typeof value.cancelPending !== 'boolean'
  ) {
    throw new Error('Invalid game draft cancel state');
  }
  if (
    value.templateId !== undefined &&
    (typeof value.templateId !== 'string' || !isUuid(value.templateId))
  ) {
    throw new Error('Invalid template id');
  }
  if (
    value.publishedGameId !== undefined &&
    (typeof value.publishedGameId !== 'string' ||
      !isUuid(value.publishedGameId))
  ) {
    throw new Error('Invalid published game id');
  }
  if (value.startsAtIso !== undefined && !isIsoDate(value.startsAtIso)) {
    throw new Error('Invalid draft start');
  }
  const snapshot =
    value.snapshot === undefined ? undefined : parseSnapshot(value.snapshot);
  const step = value.step as GameCreationDraftStep;
  if (
    value.previewed &&
    (snapshot === undefined ||
      value.startsAtIso === undefined ||
      (step !== 'PREVIEW' && step !== 'PUBLISHED'))
  ) {
    throw new Error('Invalid previewed draft');
  }
  if (step === 'PREVIEW' && !value.previewed) {
    throw new Error('Invalid preview state');
  }
  if (
    (step === 'PUBLISHED') !== (value.publishedGameId !== undefined) ||
    (step === 'PUBLISHED' && !value.previewed)
  ) {
    throw new Error('Invalid published draft');
  }

  return {
    version: 1,
    draftId: value.draftId,
    groupId,
    actorUserId,
    step,
    ...(value.viewRevision === undefined
      ? {}
      : { viewRevision: value.viewRevision as number }),
    ...(value.editingField === undefined
      ? {}
      : {
          editingField: value.editingField as GameCreationDraft['editingField'],
        }),
    ...(value.cancelPending === undefined
      ? {}
      : { cancelPending: value.cancelPending as boolean }),
    ...(value.templateId === undefined
      ? {}
      : { templateId: asGameTemplateId(value.templateId as string) }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(value.startsAtIso === undefined
      ? {}
      : { startsAtIso: value.startsAtIso as string }),
    previewed: value.previewed,
    ...(value.publishedGameId === undefined
      ? {}
      : { publishedGameId: asGameId(value.publishedGameId as string) }),
  };
};

export const serializeGameCreationDraftData = (
  draft: GameCreationDraft,
): Record<string, unknown> =>
  serialize({
    version: draft.version,
    draftId: draft.draftId,
    step: draft.step,
    viewRevision: draft.viewRevision,
    editingField: draft.editingField,
    cancelPending: draft.cancelPending,
    templateId: draft.templateId,
    snapshot: draft.snapshot,
    startsAtIso: draft.startsAtIso,
    previewed: draft.previewed,
    publishedGameId: draft.publishedGameId,
  });

const parseSnapshot = (value: unknown): GameTemplateSnapshot => {
  if (!isRecord(value)) throw new Error('Invalid draft snapshot');
  rejectUnknownKeys(value, snapshotKeySet, 'snapshot');
  if (!snapshotKeys.every((key) => Object.hasOwn(value, key))) {
    throw new Error('Incomplete draft snapshot');
  }
  for (const key of ['name', 'venue', 'startsAtLocalTime'] as const) {
    if (typeof value[key] !== 'string') {
      throw new Error(`Invalid snapshot ${key}`);
    }
  }
  for (const key of [
    'durationMinutes',
    'capacity',
    'registrationOpensMinutesBefore',
    'tentativePromptMinutesBefore',
    'tentativeResponseMinutes',
    'reminderMinutesBefore',
  ] as const) {
    if (!Number.isSafeInteger(value[key])) {
      throw new Error(`Invalid snapshot ${key}`);
    }
  }
  if (value.address !== null && typeof value.address !== 'string') {
    throw new Error('Invalid snapshot address');
  }
  if (
    value.registrationClosesMinutesBefore !== null &&
    !Number.isSafeInteger(value.registrationClosesMinutesBefore)
  ) {
    throw new Error('Invalid snapshot closing');
  }
  if (typeof value.memberPriorityEnabled !== 'boolean') {
    throw new Error('Invalid snapshot priority');
  }
  if (
    value.defaultTotalCostMinor !== null &&
    typeof value.defaultTotalCostMinor !== 'bigint'
  ) {
    throw new Error('Invalid snapshot cost');
  }
  if (value.currency !== 'RUB') throw new Error('Invalid snapshot currency');
  if (
    !['EXACT', 'UP_1', 'UP_10', 'UP_50'].includes(value.roundingMode as string)
  ) {
    throw new Error('Invalid snapshot rounding');
  }
  return value as unknown as GameTemplateSnapshot;
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

const serialize = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? `bigint:${item}` : item,
    ),
  ) as Record<string, unknown>;

const revive = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (_key, item: unknown) => {
    if (typeof item === 'string' && /^bigint:\d+$/.test(item)) {
      return BigInt(item.slice(7));
    }
    return item;
  }) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
