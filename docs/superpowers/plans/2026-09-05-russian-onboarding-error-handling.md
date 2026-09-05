# Russian Onboarding and Webhook Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a resumable seven-step Russian Telegram group setup wizard and ensure expected `/start` and callback mistakes return HTTP 200 while genuine infrastructure failures remain retryable HTTP 500 responses.

**Architecture:** Keep onboarding state transitions in `GroupOnboardingHandlers`, extract callback/state types and Russian rendering into pure files, and add one focused repository snapshot read. Map only typed user-input and authorization failures inside the grammY adapter; let unknown, database, network, and Telegram API failures propagate to the webhook controller.

**Tech Stack:** Node.js 24, pnpm 11.19.0, TypeScript 5.9.3, NestJS 11.1.28, grammY 1.45.1, Drizzle ORM 0.45.2, PostgreSQL 16, Vitest 4.1.10, Testcontainers 12.0.4

**Spec:** `docs/superpowers/specs/2026-09-05-onboarding-and-cd-design.md`

## Global Constraints

- The interface language is Russian; do not introduce a generalized i18n system.
- The only offered time zone is `Астрахань (UTC+4)` stored as `Europe/Astrakhan`.
- Preserve the seven existing progress keys in this order: `tz`, `mp`, `tp`, `tr`, `rm`, `ro`, `pin`.
- Do not call `ConfigureGroup` until the administrator presses `✅ Сохранить настройки`.
- Use the existing `groups.onboarding_data` JSONB column; do not create a migration.
- Every callback query must be acknowledged with `answerCallbackQuery`.
- Expected user errors complete normally; unknown, PostgreSQL, Redis, network, and Telegram API errors propagate.
- Never log bot tokens, webhook secrets, signed start parameters, raw private messages, personal names, or unnecessary Telegram identifiers.
- Preserve valid add-guest start routing.
- Follow TDD: observe every focused test fail before production changes.
- Stage and commit only the files named by the current task; never add `.pnpm-store/`.

---

### Task 1: Define the typed onboarding model and callback protocol

**Files:**
- Create: `packages/telegram/src/group-onboarding.model.ts`
- Create: `packages/telegram/src/group-onboarding.model.spec.ts`
- Modify: `packages/telegram/src/index.ts`

**Interfaces:**
- Produces: `WizardCode`, `WizardProgress`, `CompleteWizardProgress`, `WizardAnswer`, and `OnboardingCallback`.
- Produces: `wizardOrder`, `parseWizardProgress`, `nextWizardCode`, `encodeAnswerCallback`, `encodeActionCallback`, and `parseOnboardingCallback`.
- Produces: `OnboardingInputError` with stable `code` values `INVALID_CALLBACK`, `INVALID_LINK`, `FOREIGN_LINK`, and `ADMIN_REQUIRED`.

- [ ] **Step 1: Write failing model and callback tests**

```ts
// packages/telegram/src/group-onboarding.model.spec.ts
import { asGroupId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  encodeActionCallback,
  encodeAnswerCallback,
  nextWizardCode,
  parseOnboardingCallback,
  parseWizardProgress,
} from './group-onboarding.model.js';

const groupId = asGroupId('00000000-0000-4000-8000-000000000001');

describe('group onboarding model', () => {
  it('finds the first unanswered step in the fixed seven-step order', () => {
    expect(nextWizardCode({ tz: 'Europe/Astrakhan', mp: true })).toBe('tp');
  });

  it('round-trips every allowed answer and both summary actions', () => {
    const callbacks = [
      encodeAnswerCallback(groupId, { code: 'tz', value: 'Europe/Astrakhan' }),
      encodeAnswerCallback(groupId, { code: 'mp', value: true }),
      encodeAnswerCallback(groupId, { code: 'tp', value: 1440 }),
      encodeAnswerCallback(groupId, { code: 'tr', value: 60 }),
      encodeAnswerCallback(groupId, { code: 'rm', value: 120 }),
      encodeAnswerCallback(groupId, { code: 'ro', value: 'UP_10' }),
      encodeAnswerCallback(groupId, { code: 'pin', value: false }),
      encodeActionCallback(groupId, 'SAVE'),
      encodeActionCallback(groupId, 'RESET'),
    ];

    expect(callbacks.every((value) => Buffer.byteLength(value) <= 64)).toBe(true);
    expect(callbacks.map(parseOnboardingCallback)).toEqual([
      { kind: 'ANSWER', groupId, answer: { code: 'tz', value: 'Europe/Astrakhan' } },
      { kind: 'ANSWER', groupId, answer: { code: 'mp', value: true } },
      { kind: 'ANSWER', groupId, answer: { code: 'tp', value: 1440 } },
      { kind: 'ANSWER', groupId, answer: { code: 'tr', value: 60 } },
      { kind: 'ANSWER', groupId, answer: { code: 'rm', value: 120 } },
      { kind: 'ANSWER', groupId, answer: { code: 'ro', value: 'UP_10' } },
      { kind: 'ANSWER', groupId, answer: { code: 'pin', value: false } },
      { kind: 'SAVE', groupId },
      { kind: 'RESET', groupId },
    ]);
  });

  it('rejects unknown persisted values and callback choices', () => {
    expect(() => parseWizardProgress({ tz: 'Europe/Moscow' })).toThrow();
    expect(() => parseOnboardingCallback(`cfg:${groupId}:tp:15`)).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.model.spec.ts`

Expected: FAIL because `group-onboarding.model.ts` does not exist.

- [ ] **Step 3: Implement the typed model and strict callback codec**

Use discriminated unions so invalid combinations cannot be constructed:

```ts
// packages/telegram/src/group-onboarding.model.ts
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

export class OnboardingInputError extends Error {
  public constructor(
    public readonly code: 'INVALID_CALLBACK' | 'INVALID_LINK' | 'FOREIGN_LINK' | 'ADMIN_REQUIRED',
  ) {
    super(code);
    this.name = 'OnboardingInputError';
  }
}

export const wizardOrder = ['tz', 'mp', 'tp', 'tr', 'rm', 'ro', 'pin'] as const;
```

Implement `parseWizardProgress` by accepting only the exact values listed in `WizardProgress`. Invalid persisted progress throws a plain `Error('Invalid stored onboarding progress')` so data corruption remains retryable/observable as HTTP 500. Implement callback values as `Europe/Astrakhan`, `0|1`, the enumerated minute values, and the four rounding modes. Encode summary actions exactly as `cfg:<uuid>:save:1` and `cfg:<uuid>:reset:1`. Throw `new OnboardingInputError('INVALID_CALLBACK')` for any malformed prefix, UUID, action, field, missing segment, extra segment, or disallowed callback value.

Export the model from `packages/telegram/src/index.ts`.

- [ ] **Step 4: Run model tests and static checks**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.model.spec.ts`

Run: `pnpm typecheck && pnpm lint`

Expected: all callback cases pass and static checks exit 0.

- [ ] **Step 5: Commit the model**

```bash
git add packages/telegram/src/group-onboarding.model.ts packages/telegram/src/group-onboarding.model.spec.ts packages/telegram/src/index.ts
git commit -m "feat: define typed onboarding callbacks"
```

---

### Task 2: Render the seven Russian steps and summaries

**Files:**
- Create: `packages/telegram/src/group-onboarding.presenter.ts`
- Create: `packages/telegram/src/group-onboarding.presenter.spec.ts`
- Modify: `packages/telegram/src/index.ts`

**Interfaces:**
- Consumes: the typed model and encoders from Task 1.
- Produces: `OnboardingView`, `ConfiguredGroupSettings`, `renderWizardView`, `renderConfiguredSummary`, and `renderStartError`.

- [ ] **Step 1: Write failing presenter tests for all user-visible states**

```ts
// packages/telegram/src/group-onboarding.presenter.spec.ts
import { asGroupId } from '@volley/domain';
import { describe, expect, it } from 'vitest';
import { renderConfiguredSummary, renderWizardView } from './group-onboarding.presenter.js';

const groupId = asGroupId('00000000-0000-4000-8000-000000000001');

describe('group onboarding presenter', () => {
  it('renders Astrakhan as step 1 of 7', () => {
    expect(renderWizardView(groupId, {})).toMatchObject({
      text: expect.stringContaining('Шаг 1 из 7'),
      keyboard: [[expect.objectContaining({ text: 'Астрахань (UTC+4)' })]],
    });
  });

  it('renders the complete draft with explicit save and reset actions', () => {
    const view = renderWizardView(groupId, {
      tz: 'Europe/Astrakhan', mp: true, tp: 1440, tr: 60,
      rm: 120, ro: 'UP_10', pin: true,
    });
    expect(view.text).toContain('Проверьте настройки');
    expect(view.text).toContain('Астрахань (UTC+4)');
    expect(view.keyboard.flat().map(({ text }) => text)).toEqual([
      '✅ Сохранить настройки',
      '🔄 Начать заново',
    ]);
  });

  it('renders saved settings without a save button', () => {
    const view = renderConfiguredSummary({
      timeZone: 'Europe/Astrakhan', memberPriorityEnabled: false,
      tentativePromptMinutesBefore: 720, tentativeResponseMinutes: 30,
      reminderMinutesBefore: 60, currency: 'RUB', roundingMode: 'EXACT',
      pinGameMessages: false,
    });
    expect(view.text).toContain('Группа уже настроена');
    expect(view.keyboard).toEqual([]);
  });
});
```

Add table-driven assertions for steps 2–7 using these exact button labels and values:

```text
2: Участники группы выше гостей | В порядке записи
3: За 24 часа | За 12 часов | За 6 часов
4: 30 минут | 1 час | 2 часа
5: За 30 минут | За 1 час | За 2 часа
6: Точно до копеек | Вверх до 1 ₽ | Вверх до 10 ₽ | Вверх до 50 ₽
7: Да | Нет
```

- [ ] **Step 2: Run the presenter test and confirm failure**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.presenter.spec.ts`

Expected: FAIL because the presenter does not exist.

- [ ] **Step 3: Implement the pure presenter**

```ts
export interface OnboardingView {
  text: string;
  parseMode?: 'HTML';
  keyboard: readonly (readonly { text: string; callbackData: string }[])[];
}

export interface ConfiguredGroupSettings {
  timeZone: string;
  memberPriorityEnabled: boolean;
  tentativePromptMinutesBefore: number;
  tentativeResponseMinutes: number;
  reminderMinutesBefore: number;
  currency: 'RUB';
  roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pinGameMessages: boolean;
}
```

Render step headings as `Настройка группы — шаг N из 7`. Include one short question under each heading. The final draft summary must include all seven values and the fixed currency `RUB`. The configured summary displays `Астрахань (UTC+4)` for `Europe/Astrakhan` and safely displays the raw IANA identifier for a pre-existing configured group that uses another zone. Use `escapeHtml` for dynamic values; do not interpolate group title or Telegram identity in this first version.

Implement user-error copy through:

```ts
export type StartErrorReason = 'BARE_START' | 'INVALID_LINK' | 'EXPIRED_LINK' | 'FOREIGN_LINK' | 'ADMIN_REQUIRED';
export const renderStartError = (reason: StartErrorReason): OnboardingView => ({
  text: ({
    BARE_START: 'Чтобы настроить группу, откройте ссылку, которую бот отправил в группу.',
    INVALID_LINK: 'Ссылка недействительна. Получите новую ссылку в группе.',
    EXPIRED_LINK: 'Срок действия ссылки истёк. Получите новую ссылку в группе.',
    FOREIGN_LINK: 'Эта ссылка предназначена для другого администратора.',
    ADMIN_REQUIRED: 'Для настройки нужны права администратора группы.',
  })[reason],
  keyboard: [],
});
```

Export the presenter from `packages/telegram/src/index.ts`.

- [ ] **Step 4: Run presenter and model tests**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.presenter.spec.ts packages/telegram/src/group-onboarding.model.spec.ts`

Expected: all Russian copy, buttons, values, and payload length assertions pass.

- [ ] **Step 5: Commit the presenter**

```bash
git add packages/telegram/src/group-onboarding.presenter.ts packages/telegram/src/group-onboarding.presenter.spec.ts packages/telegram/src/index.ts
git commit -m "feat: render Russian onboarding wizard"
```

---

### Task 3: Add an authoritative onboarding snapshot read

**Files:**
- Modify: `packages/persistence/src/repositories/group.repository.ts`
- Modify: `packages/persistence/src/repositories/group.repository.int.spec.ts`

**Interfaces:**
- Produces: `GroupOnboardingSnapshot` and `GroupRepository.getOnboardingSnapshot(groupId)`.
- The snapshot returns `onboardingState`, raw `progress`, and every saved field needed by `ConfiguredGroupSettings`.

- [ ] **Step 1: Write failing repository tests**

```ts
it('returns onboarding progress and configured settings in one snapshot', async () => {
  const group = await repo.upsertFromTelegram({
    telegramChatId: asTelegramId('-1001000000003'),
    title: 'Astrakhan',
  });
  await repo.saveWizardProgress(group.id, { tz: 'Europe/Astrakhan', mp: true });

  await expect(repo.getOnboardingSnapshot(group.id)).resolves.toMatchObject({
    onboardingState: 'PENDING',
    progress: { tz: 'Europe/Astrakhan', mp: true },
    settings: { timeZone: 'UTC', currency: 'RUB' },
  });
});

it('beginOnboarding preserves existing progress', async () => {
  const group = await repo.upsertFromTelegram({
    telegramChatId: asTelegramId('-1001000000004'), title: 'Resume',
  });
  await repo.upsertMembership(group.id, asTelegramId('42'), 'ADMIN');
  await repo.saveWizardProgress(group.id, { tz: 'Europe/Astrakhan' });
  await repo.beginOnboarding(group.id, asTelegramId('42'));

  expect(await repo.getOnboardingSnapshot(group.id)).toMatchObject({
    progress: { tz: 'Europe/Astrakhan' },
  });
});
```

- [ ] **Step 2: Run the focused integration test and confirm failure**

Run: `pnpm vitest run packages/persistence/src/repositories/group.repository.int.spec.ts`

Expected: FAIL because `getOnboardingSnapshot` is missing.

- [ ] **Step 3: Implement the single-query snapshot**

```ts
export interface GroupOnboardingSnapshot {
  onboardingState: OnboardingState;
  progress: Record<string, unknown>;
  settings: {
    timeZone: string;
    memberPriorityEnabled: boolean;
    tentativePromptMinutesBefore: number;
    tentativeResponseMinutes: number;
    reminderMinutesBefore: number;
    currency: 'RUB';
    roundingMode: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
    pinGameMessages: boolean;
  };
}
```

Implement `getOnboardingSnapshot(groupId): Promise<GroupOnboardingSnapshot | null>`. Select those fields from `groups` by `groupId`, map `onboardingData` to `progress`, and return `null` when no row exists. A missing row can then be mapped to an expected invalid link/button without hiding an actual rejected database query. Do not change the schema or `beginOnboarding`; its current update already preserves `onboardingData`.

Before returning a non-null snapshot, assert `currency === 'RUB'` and `roundingMode` is one of `EXACT`, `UP_1`, `UP_10`, or `UP_50`; throw a plain `Error('Invalid stored group settings')` if persisted data violates those invariants. That plain error intentionally remains an HTTP 500 data-integrity failure rather than a user-input outcome.

- [ ] **Step 4: Run repository and migration regression tests**

Run: `pnpm vitest run packages/persistence/src/repositories/group.repository.int.spec.ts packages/persistence/src/migrations/migrations.int.spec.ts`

Expected: snapshot tests pass and the existing migrations remain unchanged and idempotent.

- [ ] **Step 5: Commit the repository read**

```bash
git add packages/persistence/src/repositories/group.repository.ts packages/persistence/src/repositories/group.repository.int.spec.ts
git commit -m "feat: read group onboarding snapshot"
```

---

### Task 4: Make the handler resumable, editable, and confirmation-based

**Files:**
- Modify: `packages/telegram/src/group-onboarding.handlers.ts`
- Modify: `packages/telegram/src/group-onboarding.e2e.spec.ts`

**Interfaces:**
- Consumes: `parseWizardProgress`, `parseOnboardingCallback`, and presenter functions from Tasks 1–2.
- Consumes: `getOnboardingSnapshot` from Task 3.
- Changes: `handleCallback` input adds `messageId: bigint`.
- Produces: `OnboardingCallbackResult = { notice?: string; showAlert?: boolean }` for adapter acknowledgement.

- [ ] **Step 1: Rewrite the main e2e test to fail on the new workflow**

Capture both sends and edits in the harness:

```ts
const telegram: TelegramGateway = {
  getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
  sendMessage: vi.fn(async (chatId, message, options) => {
    messages.push({ kind: 'send', chatId, message, options });
    return { messageId: 500n };
  }),
  editMessage: vi.fn(async (chatId, messageId, message, options) => {
    messages.push({ kind: 'edit', chatId, messageId, message, options });
  }),
};
```

Drive callbacks by reading `callback_data` from the last rendered keyboard rather than rebuilding strings in the test. Assert:

```ts
expect(lastView().message).toContain('шаг 1 из 7');
await click('Астрахань (UTC+4)');
expect(lastView()).toMatchObject({ kind: 'edit', messageId: 500n });
// click the remaining six choices
expect(lastView().message).toContain('Проверьте настройки');
expect(configureSpy).not.toHaveBeenCalled();
await click('✅ Сохранить настройки');
expect(await groups.findById(groupId)).toMatchObject({
  onboardingState: 'CONFIGURED', timeZone: 'Europe/Astrakhan',
});
```

Add separate tests for reset, repeated `/start` resume, a stale repeated step callback, re-add of an unfinished group, and re-add of a configured group.

- [ ] **Step 2: Run the onboarding e2e test and confirm failure**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.e2e.spec.ts`

Expected: FAIL because the handler still sends placeholders, configures immediately after step 7, and ignores incomplete existing groups on re-add.

- [ ] **Step 3: Implement state transitions and one-message editing**

Change the handler repository port to:

```ts
export interface OnboardingHandlerRepository {
  findByTelegramChatId(telegramChatId: TelegramId): Promise<Group | null>;
  setEnabled(groupId: GroupId, enabled: boolean): Promise<Group>;
  getOnboardingSnapshot(groupId: GroupId): Promise<{
    onboardingState: 'PENDING' | 'CONFIGURING' | 'CONFIGURED';
    progress: Record<string, unknown>;
    settings: ConfiguredGroupSettings;
  } | null>;
  saveWizardProgress(groupId: GroupId, progress: Record<string, unknown>): Promise<void>;
}
```

Implement callback branching exactly as follows:

```ts
const snapshot = await groups.getOnboardingSnapshot(callback.groupId);
if (snapshot === null) throw new OnboardingInputError('INVALID_CALLBACK');
const progress = parseWizardProgress(snapshot.progress);

if (snapshot.onboardingState === 'CONFIGURED') {
  await editOrReplace(chatId, messageId, renderConfiguredSummary(snapshot.settings));
  return { notice: 'Настройки уже сохранены' };
}

switch (callback.kind) {
  case 'RESET':
    await groups.saveWizardProgress(callback.groupId, {});
    await editOrReplace(chatId, messageId, renderWizardView(callback.groupId, {}));
    return {};
  case 'SAVE':
    if (nextWizardCode(progress) !== undefined) {
      await editOrReplace(chatId, messageId, renderWizardView(callback.groupId, progress));
      return { notice: 'Сначала завершите все шаги', showAlert: true };
    }
    await configure.execute(toConfigureCommand(callback.groupId, userId, progress));
    const configured = await groups.getOnboardingSnapshot(callback.groupId);
    if (configured === null) throw new Error('Configured group missing');
    await editOrReplace(chatId, messageId, renderConfiguredSummary(configured.settings));
    return { notice: 'Настройки сохранены' };
  case 'ANSWER':
    if (nextWizardCode(progress) !== callback.answer.code) {
      await editOrReplace(chatId, messageId, renderWizardView(callback.groupId, progress));
      return { notice: 'Показываю текущий шаг' };
    }
    const next = { ...progress, [callback.answer.code]: callback.answer.value };
    await groups.saveWizardProgress(callback.groupId, next);
    await editOrReplace(chatId, messageId, renderWizardView(callback.groupId, next));
    return {};
}
```

`editOrReplace` calls `telegram.editMessage` when available. If it is unavailable or throws `TelegramMessageNotEditableError`, call `sendMessage` with the same rendered view. Propagate every other error.

For `handleMyChatMember`, keep disable behavior unchanged. If an existing group is `CONFIGURED`, only enable it. Otherwise call `OnboardGroup.execute` even when the group exists; its upsert and `beginOnboarding` preserve progress and its link factory creates a fresh 15-minute token.

For `handleStart`, verify the token owner and administrator, then load the snapshot. If it is `null`, throw `OnboardingInputError('INVALID_LINK')`. Send `renderConfiguredSummary` for `CONFIGURED` or `renderWizardView(groupId, parseWizardProgress(snapshot.progress))` otherwise.

- [ ] **Step 4: Run handler, repository, and presenter tests**

Run: `pnpm vitest run packages/telegram/src/group-onboarding.e2e.spec.ts packages/telegram/src/group-onboarding.presenter.spec.ts packages/telegram/src/group-onboarding.model.spec.ts packages/persistence/src/repositories/group.repository.int.spec.ts`

Expected: the seven-step, summary, save, reset, resume, stale callback, and re-add tests pass.

- [ ] **Step 5: Commit handler behavior**

```bash
git add packages/telegram/src/group-onboarding.handlers.ts packages/telegram/src/group-onboarding.e2e.spec.ts
git commit -m "feat: complete resumable group onboarding"
```

---

### Task 5: Type start-token failures and map expected errors to successful updates

**Files:**
- Modify: `packages/telegram/src/signed-start-token.ts`
- Modify: `packages/telegram/src/signed-start-token.spec.ts`
- Modify: `packages/telegram/src/bot.factory.ts`
- Modify: `packages/telegram/src/bot.factory.spec.ts`
- Modify: `packages/telegram/src/group-onboarding.handlers.ts`

**Interfaces:**
- Produces: `StartTokenVerificationError` with reason `INVALID` or `EXPIRED`.
- Consumes: `AuthorizationDeniedError` from `@volley/application` and `OnboardingInputError` from Task 1.
- `registerGroupOnboardingHandlers` acknowledges every `cfg:` callback and logs only a stable `errorCategory`.

- [ ] **Step 1: Write failing token and grammY adapter tests**

Extend `signed-start-token.spec.ts`:

```ts
expect(captureError(() => signer.verify('not-a-token', now))).toMatchObject({
  name: 'StartTokenVerificationError', reason: 'INVALID',
});
expect(captureError(() => signer.verify(expiredToken, afterExpiry))).toMatchObject({
  name: 'StartTokenVerificationError', reason: 'EXPIRED',
});
```

Extend `bot.factory.spec.ts` with a bot initialized from fixed `botInfo`, an API transformer that records `sendMessage` and `answerCallbackQuery`, and handler stubs. Cover:

```ts
it('answers bare start without throwing', async () => {
  await expect(updates.handleUpdate(startUpdate(''))).resolves.toBeUndefined();
  expect(apiCalls).toContainEqual(expect.objectContaining({ method: 'sendMessage' }));
});

it('acknowledges stale callbacks', async () => {
  handler.handleCallback.mockResolvedValue({ notice: 'Показываю текущий шаг' });
  await updates.handleUpdate(callbackUpdate(validCallback));
  expect(apiCalls.filter(({ method }) => method === 'answerCallbackQuery')).toHaveLength(1);
});

it('rethrows unknown failures for webhook retry', async () => {
  handler.handleStart.mockRejectedValue(new Error('postgres unavailable'));
  await expect(updates.handleUpdate(startUpdate(validToken))).rejects.toThrow('postgres unavailable');
});
```

Also prove that `handleStart` returning `false` calls `guestHandlers.handleStart` and produces the existing `guest:name` response.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm vitest run packages/telegram/src/signed-start-token.spec.ts packages/telegram/src/bot.factory.spec.ts`

Expected: FAIL because token errors are generic and callbacks are not acknowledged.

- [ ] **Step 3: Implement narrow error types and adapter mapping**

```ts
export class StartTokenVerificationError extends Error {
  public constructor(public readonly reason: 'INVALID' | 'EXPIRED') {
    super(`Start token ${reason.toLowerCase()}`);
    this.name = 'StartTokenVerificationError';
  }
}
```

Replace only invalid encoding/signature branches with `INVALID` and only the time comparison branch with `EXPIRED`. Keep signing validation errors unchanged because they are programming/configuration failures.

In `GroupOnboardingHandlers.handleStart`, throw `OnboardingInputError('FOREIGN_LINK')` when the verified configuration token belongs to another administrator. Let `AuthorizationDeniedError` propagate unchanged to the adapter.

In `bot.factory.ts`, add two narrow mapping helpers and use Nest's existing structured logger bridge:

```ts
import { Logger } from '@nestjs/common';

const logger = new Logger('GroupOnboarding');

const startReason = (error: unknown): StartErrorReason | undefined => {
  if (error instanceof StartTokenVerificationError)
    return error.reason === 'EXPIRED' ? 'EXPIRED_LINK' : 'INVALID_LINK';
  if (error instanceof OnboardingInputError) {
    if (error.code === 'FOREIGN_LINK') return 'FOREIGN_LINK';
    if (error.code === 'ADMIN_REQUIRED') return 'ADMIN_REQUIRED';
    return 'INVALID_LINK';
  }
  if (error instanceof AuthorizationDeniedError) return 'ADMIN_REQUIRED';
  return undefined;
};

const errorCategory = (error: unknown): string | undefined => {
  const reason = startReason(error);
  if (reason !== undefined) return `onboarding.${reason.toLowerCase()}`;
  if (error instanceof OnboardingInputError) return `onboarding.${error.code.toLowerCase()}`;
  return undefined;
};

const safeCallbackText = (error: unknown): string => {
  if (error instanceof AuthorizationDeniedError) return 'Нужны права администратора группы.';
  if (error instanceof OnboardingInputError && error.code === 'ADMIN_REQUIRED')
    return 'Нужны права администратора группы.';
  if (error instanceof OnboardingInputError && error.code === 'FOREIGN_LINK')
    return 'Эта кнопка предназначена для другого администратора.';
  return 'Кнопка устарела или недействительна.';
};
```

Special-case `context.match === ''` as `BARE_START` before token verification. For a mapped start error, log `Telegram onboarding input rejected` with `{ errorCategory }`, reply with `renderStartError(reason)`, and return. If that Telegram reply fails, allow the reply failure to propagate.

For callbacks, use one guarded acknowledgement:

```ts
try {
  const result = await handlers.handleCallback({
    telegramUserId: toTelegramId(context.callbackQuery.from.id),
    privateChatId: toTelegramId(chatId),
    messageId: BigInt(context.callbackQuery.message!.message_id),
    data: context.callbackQuery.data,
  });
  await context.answerCallbackQuery({
    text: result.notice,
    show_alert: result.showAlert,
  });
} catch (error) {
  const category = errorCategory(error);
  if (category === undefined) {
    await context.answerCallbackQuery().catch(() => undefined);
    throw error;
  }
  logger.warn('Telegram onboarding input rejected', { errorCategory: category });
  await context.answerCallbackQuery({ text: safeCallbackText(error), show_alert: true });
}
```

Do not include `error.message`, callback data, token, raw message text, or user identity in the log fields. Do not catch outside the `/start` and `cfg:` routes.

- [ ] **Step 4: Run token, factory, guest, and onboarding tests**

Run: `pnpm vitest run packages/telegram/src/signed-start-token.spec.ts packages/telegram/src/bot.factory.spec.ts packages/telegram/src/registrations/guest-flow.handlers.spec.ts packages/telegram/src/group-onboarding.e2e.spec.ts`

Expected: expected failures resolve, unknown failure rejects, every callback is acknowledged once, and guest routing still passes.

- [ ] **Step 5: Commit error semantics**

```bash
git add packages/telegram/src/signed-start-token.ts packages/telegram/src/signed-start-token.spec.ts packages/telegram/src/bot.factory.ts packages/telegram/src/bot.factory.spec.ts packages/telegram/src/group-onboarding.handlers.ts
git commit -m "fix: acknowledge expected Telegram onboarding errors"
```

---

### Task 6: Prove HTTP 200/500 behavior and update MVP acceptance

**Files:**
- Create: `apps/api/src/telegram/onboarding-webhook.e2e.spec.ts`
- Modify: `tests/e2e/fixtures/mvp-acceptance-system.ts`
- Modify: `tests/e2e/mvp-acceptance.e2e.spec.ts`
- Modify: `apps/api/src/observability/production-logging.e2e.spec.ts`

**Interfaces:**
- Consumes: the completed onboarding handler and grammY adapter.
- Produces: HTTP-level regression coverage for expected 200 and unknown 500 outcomes.
- Changes: `MvpAcceptanceSystem.onboardAndConfigureGroup` clicks actual rendered buttons and explicitly saves.

- [ ] **Step 1: Write the HTTP regression test before changing acceptance fixtures**

Create a small Fastify/Nest test application around the real `WebhookController` and a real grammY bot with deterministic `botInfo`. Use in-memory handler stubs so no external Telegram call or database is needed.

```ts
it('returns 200 for bare start and still handles the next valid update', async () => {
  const bare = await app.inject({
    method: 'POST', url: '/telegram/webhook', headers: webhookHeaders,
    payload: startUpdate(1, ''),
  });
  const valid = await app.inject({
    method: 'POST', url: '/telegram/webhook', headers: webhookHeaders,
    payload: startUpdate(2, validToken),
  });
  expect([bare.statusCode, valid.statusCode]).toEqual([200, 200]);
  expect(handlers.handleStart).toHaveBeenCalledTimes(1);
});

it('returns 500 for an unknown handler failure', async () => {
  handlers.handleStart.mockRejectedValueOnce(new Error('postgres unavailable'));
  const response = await app.inject({
    method: 'POST', url: '/telegram/webhook', headers: webhookHeaders,
    payload: startUpdate(3, validToken),
  });
  expect(response.statusCode).toBe(500);
});
```

Add cases for invalid token, expired token, foreign link, stale callback, and callback acknowledgement. Configure the bot API transformer to return successful synthetic Telegram API responses.

- [ ] **Step 2: Run the HTTP test and confirm failure**

Run: `pnpm vitest run apps/api/src/telegram/onboarding-webhook.e2e.spec.ts`

Expected: FAIL until the test harness and Task 5 error mapping are wired correctly.

- [ ] **Step 3: Update the MVP fixture to click real buttons**

Change `MvpAcceptanceSystem`'s onboarding Telegram gateway to implement `editMessage`. Record `editMessageText` calls in the same `botApiCalls` collection already used by game flows.

Change `onboardAndConfigureGroup` to accept only `Europe/Astrakhan`, read each callback from the most recent bot response, and click:

```text
Астрахань (UTC+4)
Участники группы выше гостей
За 24 часа
1 час
За 2 часа
Точно до копеек
Да
✅ Сохранить настройки
```

Do not construct `cfg:` data in this helper. Delete assertions for `onboarding:tz` and `onboarding:complete`; assert Russian step 1, the draft summary, and the configured summary instead. Change other acceptance fixtures from `Europe/Moscow` and `Asia/Yekaterinburg` to `Europe/Astrakhan`; tenant isolation must be asserted through distinct group records and game visibility rather than different time zones.

- [ ] **Step 4: Add safe structured-log assertions**

In `production-logging.e2e.spec.ts`, exercise an expected invalid start through the actual bot adapter and assert the parsed JSON contains:

```ts
expect(parsedLogs(output)).toContainEqual(expect.objectContaining({
  level: 'warn',
  message: 'Telegram onboarding input rejected',
  correlationId: 'telegram-invalid-start',
  updateId: '81',
  errorCategory: 'onboarding.invalid_link',
}));
expect(output.join('\n')).not.toContain(invalidToken);
```

Keep the existing webhook success metric and correlation tests intact.

- [ ] **Step 5: Run focused and complete acceptance suites**

Run: `pnpm vitest run apps/api/src/telegram/onboarding-webhook.e2e.spec.ts apps/api/src/observability/production-logging.e2e.spec.ts packages/telegram/src/group-onboarding.e2e.spec.ts tests/e2e/mvp-acceptance.e2e.spec.ts`

Expected: all HTTP, logging, seven-step, and MVP acceptance cases pass.

- [ ] **Step 6: Commit end-to-end coverage**

```bash
git add apps/api/src/telegram/onboarding-webhook.e2e.spec.ts apps/api/src/observability/production-logging.e2e.spec.ts tests/e2e/fixtures/mvp-acceptance-system.ts tests/e2e/mvp-acceptance.e2e.spec.ts
git commit -m "test: cover onboarding recovery and webhook retries"
```

---

### Task 7: Run the full release gate and document the operator-visible flow

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: concise operator instructions for starting, resuming, and diagnosing onboarding.

- [ ] **Step 1: Add the onboarding operations section**

Add this information under `## Operations` without including production credentials:

```markdown
### Group onboarding

Add the bot to a Telegram group as an administrator. The bot posts a private-chat link valid for 15 minutes. The administrator completes all seven Russian configuration steps and confirms the summary before settings are saved. Reopening a valid link resumes the first unanswered step; re-adding the bot to an unfinished group creates a fresh link without clearing progress.

Expected user mistakes such as bare `/start`, expired links, or stale buttons are acknowledged and do not remain in Telegram's retry queue. A repeated HTTP 500 indicates an infrastructure or programming failure and should be investigated in the API container logs.
```

- [ ] **Step 2: Run every repository quality gate**

Run each command separately so a failure is attributable:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: every command exits 0. Do not declare completion from focused tests alone.

- [ ] **Step 3: Review scope and secrets before commit**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only onboarding, test, and README files from this plan are modified; no `.env`, token, private key, `compose.prod.yaml`, `Caddyfile`, or `.pnpm-store/` entry is staged.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md
git commit -m "docs: describe group onboarding operations"
```

- [ ] **Step 5: Record manual Telegram smoke-test evidence**

After CD is available or after a manual production update, verify with `@Volley_SBot`:

1. Re-add the bot to an unfinished test group and open the fresh link.
2. Complete all seven choices and verify the summary before saving.
3. Save and verify the configured summary.
4. Send bare `/start`, then open a fresh valid link.
5. Confirm the valid update is processed and Telegram webhook pending updates do not grow.

Record the deployed commit SHA and pass/fail result in the PR or task report; do not paste signed links, Telegram IDs, or application secrets.
