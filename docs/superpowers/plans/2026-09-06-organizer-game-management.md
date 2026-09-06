# Organizer Game Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every current Telegram group administrator a private, Russian-language workflow for managing reusable templates and taking a game from creation and publication through registration, completion, attendance, and payment.

**Architecture:** Extend the existing application use cases, PostgreSQL repositories, durable outbox, BullMQ scheduler, and canonical Telegram message. Keep conversational state in PostgreSQL; keep Telegram handlers thin; perform live Telegram administrator verification before mutations; publish external effects through the existing outbox/worker path.

**Tech Stack:** Node.js 24, TypeScript 5.9, NestJS 11, grammY, PostgreSQL 16, Drizzle ORM, BullMQ/Redis, Vitest 4, Testcontainers, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-09-06-organizer-game-management-design.md`

## Global Constraints

- Management occurs in the bot's private chat; group chats contain canonical game cards and participant actions only.
- The private command menu is exactly `/start`, `/games`, `/newgame`, `/templates`, `/settings`, and `/help` with the Russian descriptions from the spec.
- Bare `/start` opens the main menu without changing signed onboarding or guest-link dispatch.
- A group may have multiple templates; game creation is manual from a template; recurring auto-creation and a Mini App are out of scope.
- Every privileged mutation performs a fresh Telegram `getChatMember` check and accepts only `creator` or `administrator`.
- Callback payloads contain only version, action, and opaque identity; no role, tenant, price, capacity, or other trusted state.
- Lists contain eight games or templates per page and never show raw UUIDs.
- Input limits are exact: name 1–80 code points, venue 1–120, address 0–300, duration 15–720 minutes, capacity 1–200, and cost 0–1,000,000 RUB with at most two decimals.
- Currency remains `RUB`; existing games and templates retain snapshots when group defaults change.
- User mistakes and stale controls return Russian expected-error responses and do not make Telegram webhooks return HTTP 500.
- PostgreSQL is the source of truth. Telegram sends and edits never occur inside a database transaction.
- External delivery is leased and retry-safe, with the documented unavoidable crash window caused by Telegram's lack of caller-supplied idempotency keys.
- Each task follows red-green-refactor, runs its focused checks, and commits only its own coherent change.

---

### Task 1: Add organizer-management persistence and revisions

**Files:**
- Create: `packages/persistence/migrations/0012_organizer_game_management.sql`
- Create: `packages/persistence/src/schema/organizer-preferences.ts`
- Create: `packages/persistence/src/schema/template-wizard-drafts.ts`
- Modify: `packages/persistence/src/schema/games.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Modify: `packages/persistence/src/migrations/migrations.int.spec.ts`
- Modify: `scripts/migrate.int.spec.ts`
- Modify: `packages/domain/src/games/game.ts`
- Modify: `packages/domain/src/games/game-template.ts`
- Modify: `packages/domain/src/games/game-policy.ts`
- Modify: `packages/persistence/src/repositories/game.repository.ts`
- Modify: `packages/domain/src/games/game-policy.spec.ts`
- Modify: `packages/application/src/games/create-game.spec.ts`
- Modify: `packages/application/src/scheduling/schedule-policy.spec.ts`
- Modify: `packages/application/src/scheduling/reconcile-game-jobs.spec.ts`
- Modify: `apps/worker/src/scheduling/game-scheduler.consumer.spec.ts`
- Modify: `apps/worker/src/scheduling/game-scheduler.consumer.int.spec.ts`
- Modify: `apps/worker/src/scheduling/redis-recovery.e2e.spec.ts`
- Modify: `tests/e2e/fixtures/test-system.ts`
- Test: `packages/persistence/src/migrations/migrations.int.spec.ts`
- Test: `packages/persistence/src/repositories/game.repository.int.spec.ts`

**Interfaces:**
- Produces: required `Game.revision: number`.
- Produces: required `GameTemplate.revision: number` and `GameTemplate.archivedAt: Date | null`.
- Produces: `organizerPreferences(userId, selectedGroupId, updatedAt)`.
- Produces: `templateWizardDrafts(groupId, actorUserId, data, updatedAt)`.
- Produces: nullable `games.canonicalPinFailedAt` in persistence; it is not part of the domain `Game`.

- [ ] **Step 1: Write migration assertions before the migration**

Add assertions that a migrated empty database contains `organizer_preferences` and `template_wizard_drafts`, that both revision columns default to zero, and that duplicate active template names fail case-insensitively.

```ts
expect(firstTables).toContain('organizer_preferences');
expect(firstTables).toContain('template_wizard_drafts');

await pool.query(
  'INSERT INTO game_templates (group_id, name, venue, starts_at_local_time, duration_minutes, capacity, registration_opens_minutes_before, tentative_prompt_minutes_before, tentative_response_minutes, reminder_minutes_before, member_priority_enabled, currency, rounding_mode) VALUES ($1, $2, $3, $4, 120, 14, 1440, 720, 60, 120, true, $5, $6)',
  [groupId, 'Среда', 'Зал', '19:00', 'RUB', 'EXACT'],
);
await expect(insertTemplate(groupId, ' среда '))
  .rejects.toMatchObject({ code: '23505' });
```

- [ ] **Step 2: Run migration tests and verify the red state**

Run: `pnpm vitest run packages/persistence/src/migrations/migrations.int.spec.ts scripts/migrate.int.spec.ts`

Expected: FAIL because migration 0012 and the two tables/columns/indexes do not exist and the migration count is still 11.

- [ ] **Step 3: Add the additive migration and Drizzle schema**

Create `0012_organizer_game_management.sql` with:

```sql
ALTER TABLE game_templates
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS canonical_pin_failed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS game_templates_active_name_unique
  ON game_templates (group_id, LOWER(BTRIM(name)))
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS organizer_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS template_wizard_drafts (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, actor_user_id)
);
```

Add named `game_templates_revision_check` and `games_revision_check` constraints inside the same `DO $$ ... $$` existence guards used by migration 0011.

- [ ] **Step 4: Map the new schema and domain fields**

Add the two schema files, export them from `schema/index.ts`, and map revisions in `GameRepository`.

```ts
export interface Game {
  // existing fields stay unchanged
  revision: number;
  scheduleRevision: number;
}

export interface GameTemplate extends GameTemplateSnapshot {
  id: GameTemplateId;
  groupId: GroupId;
  revision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Set `revision: 0` in `createGameFromTemplate` and add `revision: 0` to explicit `Game` fixtures. Add `revision: 0` and `archivedAt: null` to explicit `GameTemplate` fixtures.

- [ ] **Step 5: Update migration counts and run focused verification**

Change the migration-runner expectation from 11 to 12 and add the two new tables to the sorted table list.

Run: `pnpm vitest run packages/persistence/src/migrations/migrations.int.spec.ts packages/persistence/src/repositories/game.repository.int.spec.ts scripts/migrate.int.spec.ts`

Expected: PASS.

Run: `pnpm typecheck`

Expected: PASS with every `Game` and `GameTemplate` fixture carrying the new required fields.

- [ ] **Step 6: Commit the persistence foundation**

```bash
git add packages/domain packages/persistence scripts/migrate.int.spec.ts apps packages/application packages/telegram tests
git commit -m "feat: add organizer management persistence"
```

---

### Task 2: Resolve and live-authorize organizer groups

**Files:**
- Create: `packages/application/src/groups/resolve-organizer-context.ts`
- Create: `packages/application/src/groups/resolve-organizer-context.spec.ts`
- Create: `packages/persistence/src/repositories/organizer-directory.repository.ts`
- Create: `packages/persistence/src/repositories/organizer-directory.repository.int.spec.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface OrganizerGroupCandidate {
  groupId: GroupId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
  selected: boolean;
}

export interface OrganizerContext {
  groupId: GroupId;
  userId: UserId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
}

export class ResolveOrganizerContext {
  list(telegramUserId: TelegramId): Promise<readonly OrganizerGroupCandidate[]>;
  require(
    telegramUserId: TelegramId,
    requestedGroupId?: GroupId,
  ): Promise<OrganizerContext>;
  select(telegramUserId: TelegramId, groupId: GroupId): Promise<OrganizerContext>;
}
```

- Consumes: `TelegramGateway.getChatMember` and a persistence port that lists known memberships, updates their live role/status, and stores the selected group.

- [ ] **Step 1: Write unit tests for live authorization and selection**

Cover one group auto-selection, multiple groups, stale stored admin demotion, Telegram `creator -> OWNER`, `administrator -> ADMIN`, and rejection of an unconfigured/disabled group.

```ts
it('drops a stale stored admin and keeps a live Telegram administrator', async () => {
  const result = await service.list(telegramUserId);
  expect(result.map((group) => group.groupId)).toEqual([liveGroupId]);
  expect(directory.refreshMembership).toHaveBeenCalledWith({
    groupId: liveGroupId,
    telegramUserId,
    role: 'ADMIN',
    status: 'ACTIVE',
  });
});
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run: `pnpm vitest run packages/application/src/groups/resolve-organizer-context.spec.ts`

Expected: FAIL because `ResolveOrganizerContext` does not exist.

- [ ] **Step 3: Implement the application service**

Map Telegram statuses exactly:

```ts
const administrativeRole = (
  status: TelegramMemberStatus,
): 'OWNER' | 'ADMIN' | null =>
  status === 'creator' ? 'OWNER' :
  status === 'administrator' ? 'ADMIN' :
  null;
```

`list` verifies every known candidate, refreshes stored membership, returns only enabled `CONFIGURED` groups, and preserves the stored valid selection. `require` uses the sole group automatically, uses the selected group when still valid, and otherwise throws `OrganizerGroupSelectionRequiredError`. `select` verifies the requested group before persisting the preference.

- [ ] **Step 4: Write repository integration tests**

Seed one user with memberships in two groups, select the second group, disable it, and assert that candidate listing still returns sufficient data for the application service while the stored preference becomes invalid through the service.

Run: `pnpm vitest run packages/persistence/src/repositories/organizer-directory.repository.int.spec.ts`

Expected: FAIL because `OrganizerDirectoryRepository` is missing.

- [ ] **Step 5: Implement the organizer directory repository**

Keep menu-specific joins out of `GroupRepository`:

```ts
class OrganizerDirectoryRepository {
  listKnownGroups(telegramUserId: TelegramId): Promise<readonly StoredOrganizerGroup[]>;
  findKnownGroup(groupId: GroupId, telegramUserId: TelegramId): Promise<StoredOrganizerGroup | null>;
  refreshMembership(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId>;
  selectedGroup(telegramUserId: TelegramId): Promise<GroupId | null>;
  saveSelectedGroup(telegramUserId: TelegramId, groupId: GroupId): Promise<void>;
}
```

Use a transaction for user/membership upsert and preference update. Tenant lookups always join through `group_members` and `groups`.

- [ ] **Step 6: Run focused verification and commit**

Run: `pnpm vitest run packages/application/src/groups/resolve-organizer-context.spec.ts packages/persistence/src/repositories/organizer-directory.repository.int.spec.ts`

Expected: PASS.

```bash
git add packages/application packages/persistence
git commit -m "feat: resolve live organizer groups"
```

---

### Task 3: Add the private command menu and organizer home

**Files:**
- Create: `packages/telegram/src/organizer/command-menu.ts`
- Create: `packages/telegram/src/organizer/command-menu.spec.ts`
- Create: `packages/telegram/src/organizer/main-menu.presenter.ts`
- Create: `packages/telegram/src/organizer/main-menu.presenter.spec.ts`
- Create: `packages/telegram/src/organizer/main-menu.handlers.ts`
- Create: `packages/telegram/src/organizer/main-menu.handlers.spec.ts`
- Modify: `packages/telegram/src/bot.factory.ts`
- Modify: `packages/telegram/src/bot.factory.spec.ts`
- Modify: `packages/telegram/src/index.ts`

**Interfaces:**
- Produces `PRIVATE_COMMANDS` with the six exact commands from the spec.
- Produces `OrganizerMenuHandlers.openHome(telegramUserId)` and `selectGroup(...)`; section buttons delegate through injected `OrganizerSectionHandlers` so later tasks attach games/templates/settings without changing start dispatch.
- Produces `registerOrganizerMenuHandlers(bot, handlers)`.
- Changes `registerGroupOnboardingHandlers` to accept an optional `bareStart` handler while preserving signed-token ownership.

- [ ] **Step 1: Write command and start-dispatch tests**

```ts
expect(PRIVATE_COMMANDS).toEqual([
  { command: 'start', description: 'Главное меню' },
  { command: 'games', description: 'Мои игры' },
  { command: 'newgame', description: 'Создать игру' },
  { command: 'templates', description: 'Шаблоны игр' },
  { command: 'settings', description: 'Настройки группы' },
  { command: 'help', description: 'Помощь' },
]);

await updates.handleUpdate(startUpdate(1, ''));
expect(bareStart.openHome).toHaveBeenCalledWith(asTelegramId('42'));
expect(onboarding.handleStart).not.toHaveBeenCalled();
```

Also prove that `/start signed-token` still calls onboarding first and then guest handling, and that bare `/start` in a group does not render organizer controls.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run packages/telegram/src/organizer packages/telegram/src/bot.factory.spec.ts`

Expected: FAIL because the command/menu modules and bare-start handler do not exist.

- [ ] **Step 3: Implement command definitions and Russian presenters**

Use a shared view:

```ts
export interface OrganizerView {
  text: string;
  parseMode: 'HTML';
  keyboard: readonly (readonly {
    text: string;
    callbackData: string;
  }[])[];
}
```

Render the home buttons from the approved menu. Show `Выбрать группу` only when two or more verified groups exist. Escape all group titles as HTML.

- [ ] **Step 4: Implement menu callbacks and bare start**

Register `/games` and the `om:` callback namespace in `main-menu.handlers.ts`. Keep `/newgame`, `/templates`, and `/settings` delegation as injected handler methods so later tasks attach real flows without modifying start-token dispatch again.

When `context.match` is empty, `bot.factory.ts` calls `bareStart.openHome` only for private chats. When it is non-empty, retain the current onboarding → guest → unsupported-link order exactly.

- [ ] **Step 5: Run focused verification and commit**

Run: `pnpm vitest run packages/telegram/src/organizer packages/telegram/src/bot.factory.spec.ts packages/telegram/src/group-onboarding.e2e.spec.ts packages/telegram/src/registrations/guest-flow.handlers.spec.ts`

Expected: PASS.

```bash
git add packages/telegram
git commit -m "feat: add private organizer menu"
```

---

### Task 4: Complete template storage and application use cases

**Files:**
- Create: `packages/application/src/games/template-errors.ts`
- Create: `packages/application/src/games/template-validation.ts`
- Create: `packages/application/src/games/template-validation.spec.ts`
- Create: `packages/application/src/games/list-templates.ts`
- Create: `packages/application/src/games/update-template.ts`
- Create: `packages/application/src/games/set-template-archived.ts`
- Create: `packages/application/src/games/template-management.spec.ts`
- Modify: `packages/application/src/games/create-template.ts`
- Modify: `packages/application/src/games/ports.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/repositories/template.repository.ts`
- Create: `packages/persistence/src/repositories/template.repository.int.spec.ts`

**Interfaces:**
- `TemplateRepository.list(groupId, { archived, limit, afterId })` returns `TemplatePage`:

```ts
export interface TemplatePage {
  items: readonly GameTemplate[];
  nextCursor: GameTemplateId | null;
}
```

- `TemplateRepository.update(input)` uses `expectedRevision` and returns the updated template.
- `TemplateRepository.setArchived(input)` archives/restores with optimistic revision.
- `CreateTemplate`, `UpdateTemplate`, and `SetTemplateArchived` all require organizer authorization.
- Copying loads an existing snapshot and starts a new create draft; it does not require a separate persistence mutation.

- [ ] **Step 1: Write validation and use-case tests**

Cover every exact limit, trimmed/case-folded name collision, stale revision, cross-group ID, archive, restore collision, and exclusion of archived templates from the active list.

```ts
expect(() => validateTemplateSnapshot({
  ...validTemplate,
  capacity: 201,
})).toThrow(new TemplateInputError('CAPACITY'));

await expect(update.execute({
  groupId,
  actorUserId,
  templateId,
  expectedRevision: 2,
  snapshot: validTemplate,
})).rejects.toThrow(TemplateRevisionConflictError);
```

- [ ] **Step 2: Run tests and verify the red state**

Run: `pnpm vitest run packages/application/src/games/template-validation.spec.ts packages/application/src/games/template-management.spec.ts`

Expected: FAIL because the validation/errors/use cases and repository port methods do not exist.

- [ ] **Step 3: Implement shared template validation**

`validateTemplateSnapshot` returns a normalized copy. Count Unicode code points with `Array.from(value).length`, parse cost only at the Telegram boundary, validate integer bounds, and verify all offsets are non-negative safe integers. Throw typed errors with stable categories:

```ts
export type TemplateInputErrorCode =
  'NAME' | 'VENUE' | 'ADDRESS' | 'TIME' | 'DURATION' |
  'CAPACITY' | 'OPENING' | 'CLOSING' | 'CONFIRMATION' |
  'REMINDER' | 'COST';
```

- [ ] **Step 4: Implement use cases and repository methods**

Use `limit + 1` for cursor detection and order active templates by case-folded name then ID. Every update increments `revision` only when `groupId`, `templateId`, and `expectedRevision` all match.

Map PostgreSQL `23505` from `game_templates_active_name_unique` to `TemplateNameConflictError`. Restoring a colliding archived template returns that same typed error.

- [ ] **Step 5: Run application and PostgreSQL tests**

Run: `pnpm vitest run packages/application/src/games/template-validation.spec.ts packages/application/src/games/template-management.spec.ts packages/persistence/src/repositories/template.repository.int.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit template management**

```bash
git add packages/application packages/persistence
git commit -m "feat: add template management use cases"
```

---

### Task 5: Build the persisted template wizard

**Files:**
- Create: `packages/telegram/src/organizer/settings-editor.model.ts`
- Create: `packages/telegram/src/organizer/settings-editor.model.spec.ts`
- Create: `packages/telegram/src/organizer/input.parsers.ts`
- Create: `packages/telegram/src/organizer/input.parsers.spec.ts`
- Create: `packages/telegram/src/templates/template-wizard.model.ts`
- Create: `packages/telegram/src/templates/template-wizard.presenter.ts`
- Create: `packages/telegram/src/templates/template-wizard.handlers.ts`
- Create: `packages/telegram/src/templates/template-wizard.e2e.spec.ts`
- Create: `packages/persistence/src/repositories/template-wizard-draft.repository.ts`
- Create: `packages/persistence/src/repositories/template-wizard-draft.repository.int.spec.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/telegram/src/index.ts`

**Interfaces:**
- Produces `SettingsEditorField` and pure parsers shared by template and game override flows.
- Produces versioned `TemplateWizardDraft` with `mode: 'CREATE' | 'EDIT' | 'COPY'`, `step`, `draftId`, optional `templateId/expectedRevision`, and partial normalized snapshot.
- Produces `TemplateWizardHandlers.open/list/startCreate/startEdit/startCopy/handleCallback/handleText`.
- `handleText` returns `false` when no template draft owns the message so later text handlers can continue.

- [ ] **Step 1: Write parser and model tests**

Test `ДД.ММ.ГГГГ`, `ЧЧ:ММ`, integer ranges, ruble-to-kopeck conversion, Unicode limits, every next/back step, and rejection of unknown JSON draft keys/version.

```ts
expect(parseRubles('1250,50')).toBe(125050n);
expect(parseRubles('1000000.01')).toEqual({ error: 'COST_RANGE' });
expect(parseLocalTime('19:30')).toBe('19:30');
expect(previousTemplateStep('CAPACITY')).toBe('DURATION');
```

- [ ] **Step 2: Run parser/model tests and verify failure**

Run: `pnpm vitest run packages/telegram/src/organizer/input.parsers.spec.ts packages/telegram/src/organizer/settings-editor.model.spec.ts`

Expected: FAIL because the shared editor and parsers do not exist.

- [ ] **Step 3: Implement and test the draft repository**

`TemplateWizardDraftRepository` serializes bigint values with the existing `bigint:` convention, strictly revives a version-1 payload, upserts by `(groupId, actorUserId)`, and clears only the actor's tenant-scoped row.

Run: `pnpm vitest run packages/persistence/src/repositories/template-wizard-draft.repository.int.spec.ts`

Expected before implementation: FAIL; after implementation: PASS.

- [ ] **Step 4: Write the Telegram wizard E2E test**

Drive a grammY bot through `/templates` → `Создать шаблон` → text/button inputs → preview → save. Recreate `TemplateWizardHandlers` with the same repository halfway through and assert the next step resumes. Cover `Назад`, confirmed `Отмена`, edit stale revision, copy with renamed template, archive, restore, and eight-item pagination.

```ts
await harness.command('/templates');
await harness.callback('tw:create');
await harness.text('Среда вечером');
expect(harness.lastMessage()).toContain('<b>Проверьте шаблон</b>');
await harness.callback('tw:save');
expect(await repository.list(groupId, activePage)).toHaveLength(1);
```

- [ ] **Step 5: Implement presenter and handlers**

Use `settings-editor.model.ts` for field order and reset preview state after every mutation. All callback payloads use a compact UUID and remain under 64 UTF-8 bytes. Render typed application errors as Russian correction text; acknowledge stale callbacks once and re-render the current step.

Register `/templates` and `tw:` callbacks. Register a `message:text` middleware that calls `next()` when `handleText` returns `false` or the message begins with `/`.

- [ ] **Step 6: Run focused verification and commit**

Run: `pnpm vitest run packages/telegram/src/organizer packages/telegram/src/templates packages/persistence/src/repositories/template-wizard-draft.repository.int.spec.ts`

Expected: PASS.

```bash
git add packages/telegram packages/persistence
git commit -m "feat: add resumable template wizard"
```

---

### Task 6: Make game publication atomic and repeatable

**Files:**
- Create: `packages/application/src/games/game-creation-draft.ts`
- Create: `packages/application/src/games/publish-game.ts`
- Create: `packages/application/src/games/publish-game.spec.ts`
- Modify: `packages/application/src/games/ports.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/telegram/src/games/game-creation.handlers.ts`
- Modify: `packages/telegram/src/games/game-creation.e2e.spec.ts`
- Modify: `packages/persistence/src/repositories/game-creation-draft.repository.ts`
- Modify: `packages/persistence/src/repositories/game-creation-draft.repository.int.spec.ts`
- Modify: `packages/persistence/src/repositories/game.repository.ts`

**Interfaces:**
- Produces a versioned `GameCreationDraft` with copied `GameTemplateSnapshot`, `draftId`, `step`, `previewed`, and optional `publishedGameId`.
- Produces:

```ts
export interface PublishGameCommand {
  groupId: GroupId;
  actorUserId: UserId;
  draftId: string;
  now: Date;
}

export class PublishGame {
  execute(command: PublishGameCommand): Promise<{
    game: Game;
    created: boolean;
  }>;
}
```

- Consumes `GamePublicationRepository.publishDraft`, which locks the authoritative draft, returns the already published game when `publishedGameId` exists, or inserts exactly one game plus audit/outbox state and records the game ID before commit.

```ts
export interface GamePublicationRepository {
  publishDraft(
    input: {
      groupId: GroupId;
      actorUserId: UserId;
      draftId: string;
      now: Date;
    },
    build: (draft: GameCreationDraft) => Game,
  ): Promise<{ game: Game; created: boolean }>;
}
```

- [ ] **Step 1: Replace the old clear-after-publish test with idempotency tests**

Cover no preview, stale/wrong draft ID, past start, elapsed closing time, scheduled publication, immediate-open publication, repeat with the same update, and two concurrent publish calls.

```ts
const [first, second] = await Promise.all([
  publish.execute(command),
  publish.execute(command),
]);
expect(new Set([first.game.id, second.game.id]).size).toBe(1);
expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
```

- [ ] **Step 2: Run publication tests and verify failure**

Run: `pnpm vitest run packages/application/src/games/publish-game.spec.ts packages/telegram/src/games/game-creation.e2e.spec.ts packages/persistence/src/repositories/game-creation-draft.repository.int.spec.ts`

Expected: FAIL because `PublishGame` and the versioned draft contract are missing.

- [ ] **Step 3: Move the draft contract to application and validate stored JSON**

```ts
export interface GameCreationDraft {
  version: 1;
  draftId: string;
  groupId: GroupId;
  actorUserId: UserId;
  step: 'TEMPLATE' | 'DATE' | 'CUSTOMIZE' | 'PREVIEW' | 'PUBLISHED';
  templateId?: GameTemplateId;
  snapshot?: GameTemplateSnapshot;
  startsAtIso?: string;
  previewed: boolean;
  publishedGameId?: GameId;
}
```

Every change to template/date/overrides sets `previewed: false`. Do not clear the row after publish; a new flow replaces it only after explicit `Начать новую игру`.

- [ ] **Step 4: Implement the publication port and PostgreSQL transaction**

Inside one transaction:

1. `SELECT ... FOR UPDATE` the actor/group draft.
2. Verify `draftId` and a complete previewed snapshot.
3. Return the referenced game with `created: false` when already published.
4. Build the game with `createGameFromTemplate`.
5. Reject `startsAt <= now` and configured `registrationClosesAt <= now`.
6. Set `state` to `OPEN` when `registrationOpensAt <= now`, otherwise `SCHEDULED`.
7. Insert the game with `revision: 0`, `GAME_CREATED` audit/outbox records, and `publishedGameId` in the locked draft.

No Telegram or Redis call belongs in this transaction.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm vitest run packages/application/src/games/publish-game.spec.ts packages/telegram/src/games/game-creation.e2e.spec.ts packages/persistence/src/repositories/game-creation-draft.repository.int.spec.ts packages/persistence/src/repositories/game.repository.int.spec.ts`

Expected: PASS.

```bash
git add packages/application packages/telegram packages/persistence
git commit -m "feat: publish game drafts atomically"
```

---

### Task 7: Connect the private game-creation wizard

**Files:**
- Create: `packages/telegram/src/games/game-creation.model.ts`
- Create: `packages/telegram/src/games/game-creation.presenter.ts`
- Create: `packages/telegram/src/games/game-creation.presenter.spec.ts`
- Create: `packages/telegram/src/games/game-creation.bot.e2e.spec.ts`
- Create: `packages/telegram/src/organizer/local-date-time.ts`
- Create: `packages/telegram/src/organizer/local-date-time.spec.ts`
- Modify: `packages/telegram/src/games/game-creation.handlers.ts`
- Modify: `packages/telegram/src/messages/game-preview.renderer.ts`
- Modify: `packages/telegram/src/index.ts`

**Interfaces:**
- Produces `GameCreationHandlers.start/continue/restart/selectTemplate/setDate/editField/preview/publish/cancel/handleText`.
- Consumes `ResolveOrganizerContext`, active template listing, `GameCreationDraftRepository`, and `PublishGame`.
- Uses the shared `SettingsEditorField` and input parsers from Task 5.

- [ ] **Step 1: Write Russian presenter tests**

Assert that preview renders every required field, localizes the date with the group time zone, and distinguishes:

```ts
expect(renderGamePreview(scheduled)).toContain(
  'Регистрация откроется: 10.09.2026 в 19:00',
);
expect(renderGamePreview(openNow)).toContain('Регистрация откроется сразу');
expect(JSON.stringify(renderGamePreview(scheduled))).not.toContain(gameId);
```

- [ ] **Step 2: Write the end-to-end bot flow before registering it**

Drive `/newgame` through group choice, active template choice, `ДД.ММ.ГГГГ` input, optional edit, preview, and publish. Assert one `GAME_CREATED` row, one canonical-message outbox event, and a private success view with no UUID.

Also test resume after handler recreation, `Назад`, `Отмена`, no active templates, archived-template stale button, and duplicate publish callback.

- [ ] **Step 3: Run the tests and verify failure**

Run: `pnpm vitest run packages/telegram/src/games/game-creation.presenter.spec.ts packages/telegram/src/games/game-creation.bot.e2e.spec.ts`

Expected: FAIL because the bot wizard/model/presenter are not implemented.

- [ ] **Step 4: Implement the wizard and callback namespace**

Use `gc:` callbacks with compact IDs. `/newgame` calls live organizer resolution, auto-selects a sole group, and otherwise shows the group picker. Selecting a template copies its complete snapshot into the draft. Date parsing combines `ДД.ММ.ГГГГ` with `startsAtLocalTime` in the group's IANA time zone.

Implement `localDateTimeToInstant({ date, time, timeZone })` with built-in `Intl.DateTimeFormat`: calculate the candidate offset, adjust the UTC candidate, then round-trip formatted local components. Reject no-match and multiple-match results instead of silently normalizing a nonexistent or ambiguous local time.

The edit screen reuses Task 5's field editor. After publish, show:

```text
✅ Игра опубликована
Карточка появится в группе. Если закрепление недоступно, предупреждение будет показано в управлении игрой.
```

`handleText` returns `false` when no active game draft expects text.

- [ ] **Step 5: Run focused flow tests and commit**

Run: `pnpm vitest run packages/telegram/src/games packages/telegram/src/templates packages/telegram/src/organizer`

Expected: PASS.

```bash
git add packages/telegram
git commit -m "feat: add private game creation wizard"
```

---

### Task 8: Add lists, revisioned edits, and full lifecycle controls

**Files:**
- Create: `packages/application/src/games/list-games.ts`
- Create: `packages/application/src/games/game-edit-policy.ts`
- Create: `packages/application/src/games/game-edit-policy.spec.ts`
- Modify: `packages/application/src/games/update-game.ts`
- Modify: `packages/application/src/games/update-game.spec.ts`
- Modify: `packages/application/src/games/change-game-state.ts`
- Create: `packages/application/src/games/change-game-state.spec.ts`
- Create: `packages/application/src/games/delete-draft-game.ts`
- Create: `packages/application/src/games/delete-draft-game.spec.ts`
- Modify: `packages/application/src/games/ports.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/persistence/src/repositories/game.repository.ts`
- Modify: `packages/persistence/src/repositories/registration.repository.ts`
- Modify: `packages/persistence/src/repositories/registration-concurrency.int.spec.ts`
- Modify: `packages/persistence/src/repositories/management.repository.ts`
- Create: `packages/persistence/src/repositories/management.repository.int.spec.ts`
- Create: `packages/telegram/src/games/game-list.presenter.ts`
- Create: `packages/telegram/src/games/game-list.presenter.spec.ts`
- Modify: `packages/telegram/src/games/game-management.handlers.ts`
- Modify: `packages/telegram/src/games/game-management.handlers.spec.ts`
- Modify: `packages/telegram/src/games/management-entry.handlers.ts`
- Modify: `packages/telegram/src/games/management-entry.handlers.spec.ts`

**Interfaces:**
- `ListGames.execute({ groupId, actorUserId, bucket, limit: 8, cursor })` returns:

```ts
export interface GamePage {
  items: readonly Game[];
  nextCursor: GameId | null;
}

export type MaterialGameField = 'startsAt' | 'venue' | 'address';
```

- `UpdateGameCommand.expectedRevision` compares `games.revision`, not `scheduleRevision`.
- `UpdateGame` accepts normalized snapshot changes allowed by `game-edit-policy.ts` and returns `{ game, rosterCount, waitlistCount, materialFields: readonly MaterialGameField[] }`.
- `ChangeGameStateCommand` adds `expectedRevision` and returns the current game without a second event when the requested state is already reached.
- `DeleteDraftGame.execute({ groupId, gameId, actorUserId, expectedRevision })` physically deletes only an unpublished `DRAFT` with no canonical message or registrations.
- `ManagementRepository` returns complete private management views and can link a previously unknown live Telegram administrator from a public card.

- [ ] **Step 1: Write edit-policy and state-transition tests**

Encode the state matrix from the spec. Test locked opening/priority after the first registration, completed/cancelled read-only behavior, past-start rejection, stale revision, idempotent repeated target state, invalid transitions, and refusal to delete any non-draft or referenced draft.

```ts
expect(editableFields({ state: 'OPEN', registrationCount: 1 }))
  .not.toContain('memberPriorityEnabled');
expect(editableFields({ state: 'COMPLETED', registrationCount: 14 }))
  .toEqual([]);
```

- [ ] **Step 2: Run application tests and verify failure**

Run: `pnpm vitest run packages/application/src/games/game-edit-policy.spec.ts packages/application/src/games/update-game.spec.ts packages/application/src/games/change-game-state.spec.ts`

Expected: FAIL because full edit policy, game revision checks, and idempotent transition behavior are missing.

- [ ] **Step 3: Implement revisioned persistence and placement updates**

Extend the existing transactional `RegistrationRepository.updateGame` so it:

- locks the tenant-scoped game;
- checks `game.revision === expectedRevision`;
- validates state-allowed fields before writing;
- increments `revision` for every edit;
- increments `scheduleRevision` only when start/open/close/confirmation/reminder timing changes;
- reruns `recalculatePlacement` only when capacity or priority placement changes;
- emits one `GAME_UPDATED` audit/outbox record with `materialFields` and old/new date/time/venue values.

Update `GameRepository.updateState` to increment `revision`. `ChangeGameState` checks the expected revision under the existing lock and treats current-state equality as success without another audit/outbox record.

- [ ] **Step 4: Implement paginated queries and administrator bootstrap**

Add upcoming/history list queries ordered as specified. Extend management lookup so a public `Управление` click first resolves `game -> group -> telegramChatId`, calls live `getChatMember`, and upserts `OWNER` or `ADMIN` before checking private-chat availability. A non-admin receives `Управление доступно только администраторам группы.`

- [ ] **Step 5: Build the private management card**

Use `ga:<action>:<compactGameId>:<base36Revision>` callbacks. Render only:

- `DRAFT`: edit, publish, delete draft;
- `SCHEDULED`: edit, open now, cancel;
- `OPEN`: edit, close, cancel;
- `CLOSED`: reopen, complete, cancel;
- `COMPLETED`: attendance, settlement, summary;
- `CANCELLED`: view and hide from active list.

All external/state-changing actions have a separate confirmation callback. Replace raw `management:*` placeholder text with Russian responses. Keep UUID commands working but unadvertised.

- [ ] **Step 6: Run focused verification and commit**

Run: `pnpm vitest run packages/application/src/games packages/persistence/src/repositories/management.repository.int.spec.ts packages/persistence/src/repositories/registration-concurrency.int.spec.ts packages/telegram/src/games`

Expected: PASS.

```bash
git add packages/application packages/persistence packages/telegram
git commit -m "feat: add complete game lifecycle controls"
```

---

### Task 9: Notify material changes and harden canonical-card recovery

**Files:**
- Modify: `packages/application/src/notifications/notification-policy.ts`
- Modify: `packages/persistence/src/repositories/notification.repository.ts`
- Modify: `packages/persistence/src/repositories/game-message.repository.ts`
- Modify: `packages/telegram/src/messages/game-message.model.ts`
- Modify: `packages/telegram/src/messages/game-message-updater.ts`
- Modify: `packages/telegram/src/messages/game-message-updater.spec.ts`
- Modify: `packages/telegram/src/notifications/notification.renderer.ts`
- Modify: `apps/worker/src/telegram/game-message.consumer.ts`
- Modify: `apps/worker/src/telegram/game-message.consumer.spec.ts`
- Modify: `apps/worker/src/notifications/notification.consumer.ts`
- Modify: `apps/worker/src/notifications/notification.consumer.spec.ts`
- Modify: `tests/e2e/notification-lifecycle.e2e.spec.ts`

**Interfaces:**
- Extends `NotificationType` with `GAME_CHANGED` and `GAME_CANCELLED`.
- Adds `NotificationRepository.listActiveForGame(groupId, gameId)` for `TENTATIVE`, `ROSTERED`, and `WAITLISTED` registrations.
- Adds `NotificationConsumer.processGameEvent(eventType, payload, deterministicJobId)`.
- Adds `GameMessageViewRepository.recordPinFailure` and `clearPinFailure`.

- [ ] **Step 1: Write routing and notification tests**

Assert that ordinary `GAME_UPDATED` only routes canonical refresh, material `GAME_UPDATED` and cancellation also route one notification child job, and retries use the same deterministic child ID.

```ts
await router.process('GAME_UPDATED', {
  aggregateType: 'GAME',
  aggregateId: gameId,
  groupId,
  materialFields: ['startsAt'],
  startsAtBefore: oldIso,
  startsAtAfter: newIso,
}, 'outbox:event-id:event');

expect(notificationQueue.add).toHaveBeenCalledOnce();
expect(notificationQueue.add).toHaveBeenCalledWith(
  'GAME_UPDATED',
  expect.anything(),
  expect.objectContaining({ jobId: 'outbox:event-id:notification' }),
);
```

- [ ] **Step 2: Write pin and replacement-card tests**

Cover successful pin clearing `canonicalPinFailedAt`, pin failure recording it without failing refresh, deleted/uneditable card replacement, and concurrent refreshes producing one replacement under the advisory lock.

Run: `pnpm vitest run packages/telegram/src/messages/game-message-updater.spec.ts apps/worker/src/telegram/game-message.consumer.spec.ts apps/worker/src/notifications/notification.consumer.spec.ts`

Expected: FAIL on the new routes and repository methods.

- [ ] **Step 3: Implement participant lookup and leased delivery**

`listActiveForGame` returns all non-cancelled registrations without filtering by `scheduleRevision`. Guests notify their inviter through existing `notificationTarget` behavior. Reuse `claimDelivery/markDelivered/releaseDelivery` with `(deterministicJobId, registrationId)`.

Render Russian messages with current group-local date:

```text
Игра «Среда вечером» изменена:
Было: 10.09.2026, 19:00 — Зал 1
Стало: 11.09.2026, 20:00 — Зал 2
```

Cancellation text is `Игра «<name>» отменена.` Escape interpolated values before HTML delivery.

- [ ] **Step 4: Implement router and canonical pin recovery**

Route notification children only when `materialFields` is non-empty or `GAME_STATE_CHANGED.payload.to === 'CANCELLED'`. Continue routing both events to canonical refresh.

Catch only the pin call after a successful send/edit. Record `canonicalPinFailedAt` and log a structured warning; do not fail the message job. A later successful pin clears the field. Expose the warning in the private management view, not the public card.

- [ ] **Step 5: Run focused and lifecycle verification**

Run: `pnpm vitest run packages/telegram/src/messages packages/telegram/src/notifications apps/worker/src/telegram apps/worker/src/notifications tests/e2e/notification-lifecycle.e2e.spec.ts`

Expected: PASS, including delivery lease recovery.

- [ ] **Step 6: Commit notification and recovery behavior**

```bash
git add packages/application packages/persistence packages/telegram apps/worker tests/e2e/notification-lifecycle.e2e.spec.ts
git commit -m "feat: notify game changes and recover cards"
```

---

### Task 10: Add settings mode and assemble the production runtime

**Files:**
- Create: `packages/telegram/src/organizer/group-settings.handlers.ts`
- Create: `packages/telegram/src/organizer/group-settings.handlers.spec.ts`
- Create: `packages/telegram/src/organizer/help.presenter.ts`
- Create: `packages/telegram/src/organizer/help.presenter.spec.ts`
- Create: `apps/api/src/telegram/telegram-command-menu.service.ts`
- Create: `apps/api/src/telegram/telegram-command-menu.service.spec.ts`
- Modify: `packages/telegram/src/group-onboarding.presenter.ts`
- Modify: `packages/telegram/src/group-onboarding.presenter.spec.ts`
- Modify: `packages/telegram/src/group-onboarding.handlers.ts`
- Modify: `packages/telegram/src/index.ts`
- Modify: `apps/api/src/telegram/telegram.module.ts`
- Modify: `apps/api/src/telegram/onboarding-webhook.e2e.spec.ts`

**Interfaces:**
- Produces `GroupSettingsHandlers.open/change/handleCallback` using current configured settings and `ConfigureGroup`.
- Produces static `renderOrganizerHelp()`.
- Produces a Nest `TelegramCommandMenuService` that installs private commands asynchronously and retries with capped backoff without blocking readiness.
- Wires all repositories, use cases, handlers, commands, callbacks, and text middleware in one composition root.

- [ ] **Step 1: Write settings and help tests**

Assert the settings summary contains time zone, priority, confirmation timing, reminder, rounding, pinning, and RUB. Changing one value sends the full existing settings plus the changed value to `ConfigureGroup` and leaves templates/games untouched.

Assert help explains template → game → registration → completion → attendance → payment and contains no `gameId`, UUID, `/manage`, `/attendance`, or `/payment` instruction.

- [ ] **Step 2: Write command-installation retry tests**

Fake grammY API so the first two calls reject and the third succeeds. Advance fake timers and assert:

```ts
expect(api.setMyCommands).toHaveBeenNthCalledWith(
  3,
  PRIVATE_COMMANDS,
  { scope: { type: 'all_private_chats' }, language_code: 'ru' },
);
expect(() => service.onApplicationBootstrap()).not.toThrow();
```

Also assert organizer commands are removed from `all_group_chats` and `all_chat_administrators` scopes.

- [ ] **Step 3: Run tests and verify the red state**

Run: `pnpm vitest run packages/telegram/src/organizer apps/api/src/telegram/telegram-command-menu.service.spec.ts`

Expected: FAIL because settings/help/install service are missing.

- [ ] **Step 4: Implement settings mode**

`/settings` live-authorizes the selected group and renders current settings. `Изменить настройки` displays the same bounded choices as onboarding, but each `gs:` callback replaces one field in a complete settings snapshot and calls `ConfigureGroup` after confirmation. Do not set onboarding state back to `CONFIGURING` and do not reuse onboarding progress as a partial settings draft.

- [ ] **Step 5: Implement non-blocking command installation**

On application bootstrap, call `setMyCommands` for private Russian commands and `deleteMyCommands` for group scopes. Retry after 1, 2, 4, 8, 16, 32, 60 seconds and then every 300 seconds until success. Cancel the timer in `onApplicationShutdown`. Log only attempt count and stable error category.

- [ ] **Step 6: Assemble the Telegram runtime**

In `telegram.module.ts` instantiate and register in this order:

1. private-chat availability middleware;
2. payment and attendance text handlers, which already call `next()` when idle;
3. template and game wizard text handlers, each calling `next()` when idle;
4. organizer menu/settings/game/template callbacks and commands;
5. onboarding/start/guest handling, changed so an idle guest text handler calls `next()`;
6. participant registration and tentative callbacks.

Inject `GroupRepository`, `OrganizerDirectoryRepository`, `TemplateRepository`, `TemplateWizardDraftRepository`, `GameCreationDraftRepository`, `GameRepository`, `RegistrationRepository`, and `ManagementRepository` into their exact use cases. Keep `telegram.module.ts` as the only composition root; do not instantiate repositories inside handlers.

- [ ] **Step 7: Run API and Telegram verification**

Run: `pnpm vitest run packages/telegram apps/api/src/telegram`

Expected: PASS, including old signed onboarding/guest starts and new bare start.

- [ ] **Step 8: Commit runtime assembly**

```bash
git add packages/telegram apps/api
git commit -m "feat: wire organizer runtime and command menu"
```

---

### Task 11: Prove the complete organizer journey and document usage

**Files:**
- Create: `tests/e2e/organizer-game-management.e2e.spec.ts`
- Modify: `tests/e2e/fixtures/mvp-acceptance-system.ts`
- Modify: `tests/e2e/mvp-acceptance.e2e.spec.ts`
- Modify: `tests/e2e/security.e2e.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Produces one black-box Telegram acceptance test covering the entire approved organizer journey.
- Preserves all existing release, CI, deployment, onboarding, registration, attendance, payment, and worker recovery contracts.

- [ ] **Step 1: Add the failing black-box journey**

Use real PostgreSQL and Redis Testcontainers plus the existing fake Telegram gateway:

```ts
it('takes an administrator from bare start through settlement without UUID commands', async () => {
  await system.sendPrivateCommand(admin, '/start');
  await system.createTemplateThroughTelegram(admin, templateInput);
  const game = await system.createAndPublishGameThroughTelegram(admin, localDate);
  await system.runScheduledOpening(game.id);
  await system.pressGoing(member, game.id);
  await system.closeAndCompleteThroughTelegram(admin, game.id);
  await system.finalizeAttendanceThroughTelegram(admin, game.id);
  await system.finalizeSettlementThroughTelegram(admin, game.id);

  expect(await system.canonicalMessages(game.id)).toHaveLength(1);
  expect(system.visibleMessages()).not.toContainMatch(UUID_PATTERN);
});
```

Add cases for multiple groups, lost Telegram admin status, cross-group callback tampering, duplicate publish, concurrent edit, resume after API recreation, archived templates, material-change delivery deduplication, cancellation, pin failure, and deleted-card replacement.

- [ ] **Step 2: Run the new E2E test and verify failure**

Run: `pnpm vitest run tests/e2e/organizer-game-management.e2e.spec.ts tests/e2e/security.e2e.spec.ts`

Expected: FAIL until fixture helpers and any missed runtime seams are complete.

- [ ] **Step 3: Complete fixture wiring and close only observed gaps**

Add fixture methods that submit actual Telegram updates and inspect persisted state; do not call application handlers directly in the black-box test. Fix only behavior required by the spec and failing acceptance assertions. Keep all error copy Russian and keep callback payloads below 64 bytes.

- [ ] **Step 4: Add operator/user documentation**

Add this concise `README.md` section:

```markdown
## Управление играми

1. Откройте личный чат с ботом и отправьте `/start`.
2. Создайте шаблон через `/templates`.
3. Создайте игру через `/newgame`, проверьте карточку и опубликуйте её.
4. Открывайте игру через `/games`; после завершения там появятся посещаемость и оплаты.
```

Document that the command menu is private, only current Telegram administrators may mutate state, registration opening follows the template, and recurring creation is not included.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
docker build -f docker/api.Dockerfile .
docker build -f docker/worker.Dockerfile .
```

Expected: every command exits 0; Vitest reports no failed files or tests; both production Docker images build.

- [ ] **Step 6: Review migration and callback contracts**

Run:

```bash
pnpm vitest run scripts/migrate.int.spec.ts packages/persistence/src/migrations/migrations.int.spec.ts tests/e2e/security.e2e.spec.ts tests/release
git diff --check
git status --short
```

Expected: all focused release/security checks pass, `git diff --check` is silent, and status contains only the intended implementation/docs changes.

- [ ] **Step 7: Commit the acceptance milestone**

```bash
git add tests README.md packages apps
git commit -m "test: prove organizer game workflow"
```

After the commit, run `git status --short` and require empty output before branch completion review.
