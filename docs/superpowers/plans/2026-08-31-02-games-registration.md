# Games and Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add templates, games, deterministic priority-aware registration, guests, waitlist promotion, and Telegram creation/registration flows.

**Architecture:** Pure domain policies calculate lifecycle transitions and roster placement. Application services coordinate tenant-scoped repositories and write audit/outbox events in the same PostgreSQL transaction; Telegram handlers only translate callbacks and render results.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9.3, NestJS 11.1.28, grammY 1.45.1, Drizzle ORM 0.45.2, PostgreSQL 16, Vitest 4.1.10, fast-check 4.9.0

**Spec:** `docs/superpowers/specs/2026-08-31-volleyball-bot-design.md`

## Global Constraints

- Complete `2026-08-31-01-foundation-onboarding.md` first.
- Free-form chat text and reactions never create registrations.
- Tentative registrations never consume capacity.
- Queue order is manual override, group member, confirmation time, stable identifier.
- Every placement mutation is atomic and serialized per game.
- Repeated callbacks and duplicate Telegram updates are idempotent.
- Game timestamps are UTC; display uses the group's IANA time zone.
- Follow TDD and commit after every task.

---

### Task 1: Model templates and game lifecycle

**Files:**
- Create: `packages/domain/src/games/game.ts`
- Create: `packages/domain/src/games/game-template.ts`
- Create: `packages/domain/src/games/game-policy.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/domain/src/games/game-policy.spec.ts`
- Create: `packages/persistence/src/schema/games.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/migrations/0002_games.sql`

**Interfaces:**
- Produces: `GameState = 'DRAFT' | 'SCHEDULED' | 'OPEN' | 'CLOSED' | 'COMPLETED' | 'CANCELLED'`.
- Produces: `GameTemplateSnapshot`, `Game`, `createGameFromTemplate`, and `transitionGame`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
describe('transitionGame', () => {
  it('allows a scheduled game to open', () => {
    expect(transitionGame('SCHEDULED', 'OPEN')).toBe('OPEN');
  });

  it.each([
    ['COMPLETED', 'OPEN'],
    ['CANCELLED', 'OPEN'],
    ['DRAFT', 'COMPLETED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => transitionGame(from, to)).toThrow(/invalid game transition/i);
  });
});

it('copies a template snapshot instead of retaining a mutable reference', () => {
  const game = createGameFromTemplate(template, startAt);
  template.capacity = 99;
  expect(game.capacity).toBe(14);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/domain/src/games/game-policy.spec.ts`

Expected: FAIL because game types and policies are absent.

- [ ] **Step 3: Implement domain rules and database schema**

Implement the explicit transition map:

```ts
const allowed: Record<GameState, readonly GameState[]> = {
  DRAFT: ['SCHEDULED', 'OPEN', 'CANCELLED'],
  SCHEDULED: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED', 'CANCELLED'],
  CLOSED: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
```

Create `game_templates` and `games` tables. Store all copied settings directly on `games`, including capacity, time zone, opening/closing times, tentative timing, reminder timing, priority flag, currency, rounding mode, optional total cost, `schedule_revision`, and nullable `canonical_telegram_message_id BIGINT`. Add check constraints for positive capacity and valid time ordering.

- [ ] **Step 4: Run domain and migration verification**

Run: `pnpm vitest run packages/domain/src/games/game-policy.spec.ts`

Run: `pnpm typecheck && pnpm lint`

Run the migration integration helper against a fresh PostgreSQL container and expect all migrations to apply once.

- [ ] **Step 5: Commit game lifecycle**

```bash
git add packages/domain packages/persistence
git commit -m "feat: model game templates and lifecycle"
```

---

### Task 2: Implement tenant-scoped template and game use cases

**Files:**
- Create: `packages/application/src/games/ports.ts`
- Create: `packages/application/src/games/create-template.ts`
- Create: `packages/application/src/games/create-game.ts`
- Create: `packages/application/src/games/change-game-state.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/repositories/template.repository.ts`
- Create: `packages/persistence/src/repositories/game.repository.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/application/src/games/create-game.spec.ts`
- Test: `packages/persistence/src/repositories/game.repository.int.spec.ts`

**Interfaces:**
- Produces: `TemplateRepository`, `GameRepository`, and `UnitOfWork` ports.
- Produces: `CreateTemplate.execute`, `CreateGame.execute`, and `ChangeGameState.execute`.
- Produces: `GameRepository.withLockedGame(groupId, gameId, callback)`.

- [ ] **Step 1: Write failing use-case tests**

```ts
it('creates a game with a template snapshot inside the actor group', async () => {
  authorization.requireOrganizer.mockResolvedValue(undefined);
  const result = await useCase.execute({
    groupId,
    actorUserId,
    templateId,
    startsAt: new Date('2026-09-01T16:00:00.000Z'),
    overrides: { capacity: 18 },
  });

  expect(result.capacity).toBe(18);
  expect(games.insert).toHaveBeenCalledWith(
    expect.objectContaining({ groupId, sourceTemplateId: templateId }),
  );
});

it('rejects a template from another group', async () => {
  templates.findById.mockResolvedValue(null);
  await expect(useCase.execute(command)).rejects.toThrow(/template not found/i);
});

```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/games/create-game.spec.ts packages/persistence/src/repositories/game.repository.int.spec.ts`

Expected: FAIL because ports, use cases, and repositories are missing.

- [ ] **Step 3: Implement use cases and locked repository operations**

Use this command boundary:

```ts
export interface CreateGameCommand {
  groupId: GroupId;
  actorUserId: UserId;
  templateId?: GameTemplateId;
  startsAt: Date;
  overrides: Partial<GameTemplateSnapshot>;
}
```

Every use case calls `authorization.requireOrganizer(groupId, actorUserId)`. Creation writes `GameCreated` and `GamePublished` outbox events when appropriate. `withLockedGame` must execute `SELECT ... FOR UPDATE` inside the transaction before invoking its callback.

- [ ] **Step 4: Run focused and static verification**

Run: `pnpm vitest run packages/application/src/games/create-game.spec.ts packages/persistence/src/repositories/game.repository.int.spec.ts`

Run: `pnpm typecheck && pnpm lint`

Expected: all commands exit 0.

- [ ] **Step 5: Commit game use cases**

```bash
git add packages/application packages/persistence
git commit -m "feat: add game and template use cases"
```

---

### Task 3: Build the deterministic registration policy

**Files:**
- Create: `packages/domain/src/registrations/registration.ts`
- Create: `packages/domain/src/registrations/placement-policy.ts`
- Create: `packages/domain/src/registrations/registration-errors.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/registrations/placement-policy.spec.ts`
- Test: `packages/domain/src/registrations/placement-policy.property.spec.ts`

**Interfaces:**
- Produces: `RegistrationState = 'TENTATIVE' | 'ROSTERED' | 'WAITLISTED' | 'CANCELLED'`.
- Produces: `rankConfirmedRegistrations(input)` and `placeConfirmedRegistrations(input)`.
- Produces: `RegistrationCandidate` with `manualRank`, `membershipPriority`, `confirmedAt`, and `id`.

- [ ] **Step 1: Write failing example and property tests**

```ts
it('places members before earlier guests', () => {
  const placed = placeConfirmedRegistrations({
    capacity: 1,
    registrations: [guestAt('09:00'), memberAt('09:01')],
  });
  expect(placed.roster.map((item) => item.kind)).toEqual(['MEMBER']);
  expect(placed.waitlist.map((item) => item.kind)).toEqual(['GUEST']);
});

it('never lets tentative registrations consume capacity', () => {
  fc.assert(
    fc.property(candidateListArbitrary, fc.integer({ min: 1, max: 30 }), (items, capacity) => {
      const result = placeConfirmedRegistrations({ capacity, registrations: items });
      expect(result.roster.length).toBeLessThanOrEqual(capacity);
      expect(result.roster.every((item) => item.state !== 'TENTATIVE')).toBe(true);
    }),
  );
});
```

Also test manual rank, confirmation-time ordering, stable-ID tie-breaking, zero confirmed participants, capacity reduction, and automatic first-waitlisted promotion.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/domain/src/registrations/placement-policy.spec.ts packages/domain/src/registrations/placement-policy.property.spec.ts`

Expected: FAIL because the policy is missing.

- [ ] **Step 3: Implement a pure stable comparator and placement function**

```ts
const compare = (a: RegistrationCandidate, b: RegistrationCandidate): number =>
  compareNullableNumber(a.manualRank, b.manualRank) ||
  b.membershipPriority - a.membershipPriority ||
  a.confirmedAt.getTime() - b.confirmedAt.getTime() ||
  a.id.localeCompare(b.id);

export function placeConfirmedRegistrations(input: PlacementInput): PlacementResult {
  const ranked = input.registrations
    .filter((item) => item.state !== 'TENTATIVE' && item.state !== 'CANCELLED')
    .toSorted(compare);
  return {
    roster: ranked.slice(0, input.capacity),
    waitlist: ranked.slice(input.capacity),
  };
}
```

Do not access clocks, repositories, or Telegram from this package.

- [ ] **Step 4: Run all policy tests**

Run: `pnpm vitest run packages/domain/src/registrations`

Expected: example and property tests pass with no shrinking counterexample.

- [ ] **Step 5: Commit the policy**

```bash
git add packages/domain/src/registrations packages/domain/src/index.ts
git commit -m "feat: add deterministic roster placement policy"
```

---

### Task 4: Persist and transact registration changes

**Files:**
- Create: `packages/persistence/src/schema/registrations.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/migrations/0003_registrations.sql`
- Create: `packages/application/src/registrations/ports.ts`
- Create: `packages/application/src/registrations/register-participant.ts`
- Create: `packages/application/src/registrations/register-guest.ts`
- Create: `packages/application/src/registrations/withdraw-registration.ts`
- Create: `packages/application/src/registrations/change-registration-order.ts`
- Create: `packages/application/src/registrations/admin-change-registration.ts`
- Create: `packages/application/src/games/update-game.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/repositories/registration.repository.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/application/src/registrations/register-participant.spec.ts`
- Test: `packages/persistence/src/repositories/registration-concurrency.int.spec.ts`

**Interfaces:**
- Produces: `RegisterParticipant.execute`, `RegisterGuest.execute`, `WithdrawRegistration.execute`, `ChangeRegistrationOrder.execute`, `AdminChangeRegistration.execute`, and `UpdateGame.execute`.
- Produces: result `{ registrationId; state; rosterPosition?; waitlistPosition? }`.

- [ ] **Step 1: Write failing idempotency, promotion, and concurrency tests**

```ts
it('returns the existing active registration for a repeated callback', async () => {
  const first = await register.execute(command);
  const second = await register.execute(command);
  expect(second).toEqual(first);
  expect(await countActiveRegistrations(command.gameId, command.userId)).toBe(1);
});

it('promotes exactly one waiter when a rostered participant withdraws', async () => {
  await withdraw.execute({ groupId, gameId, actorUserId: rosteredUser });
  expect(await states(gameId)).toEqual(['ROSTERED', 'WAITLISTED']);
});

it('recalculates placement when an organizer reduces capacity', async () => {
  const result = await updateGame.execute({
    groupId,
    gameId,
    actorUserId: organizer,
    expectedRevision: 3,
    changes: { capacity: 1 },
  });
  expect(result.rosterCount).toBe(1);
  expect(result.waitlistCount).toBe(1);
});
```

The concurrency test starts a capacity-one game, submits two `Going` commands with `Promise.all`, and expects one `ROSTERED` and one `WAITLISTED` row.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/registrations/register-participant.spec.ts packages/persistence/src/repositories/registration-concurrency.int.spec.ts`

Expected: FAIL because schema and transactional services do not exist.

- [ ] **Step 3: Implement schema and one transaction path for every placement change**

Create `registrations` with participant/guest check constraints, inviter, membership snapshot, state, timestamps, cancellation reason, and optional manual rank. Add a partial unique index for one active user registration per game.

All four use cases must call one internal transaction coordinator:

```ts
await unitOfWork.transaction(async (tx) => {
  const game = await games.lockById(tx, command.groupId, command.gameId);
  assertParticipantMutationAllowed(game);
  const changed = await registrations.applyCommand(tx, command);
  const active = await registrations.listActiveForUpdate(tx, command.groupId, command.gameId);
  const placement = placeConfirmedRegistrations({ capacity: game.capacity, registrations: active });
  await registrations.persistPlacement(tx, placement);
  await audit.append(tx, auditEventFor(command, changed));
  await outbox.append(tx, eventsForPlacementChange(changed, placement));
});
```

Membership priority is computed with a fresh membership lookup at registration time and stored as a snapshot. Guests always receive guest priority even when invited by a member.

`AdminChangeRegistration` requires organizer authorization and supports adding a named participant, cancelling a registration, or changing its manual rank. It delegates placement to the same transaction coordinator and always records the actor and reason.

`UpdateGame` requires organizer authorization and an expected revision, increments `schedule_revision` for timing changes, and invokes this same transaction coordinator when capacity changes.

- [ ] **Step 4: Run focused, integration, and property verification**

Run: `pnpm vitest run packages/application/src/registrations packages/persistence/src/repositories/registration-concurrency.int.spec.ts packages/domain/src/registrations`

Run: `pnpm typecheck && pnpm lint`

Expected: all registration tests pass, including repeated concurrency runs.

- [ ] **Step 5: Commit transactional registration**

```bash
git add packages/application packages/persistence
git commit -m "feat: add transactional registration and waitlist"
```

---

### Task 5: Add Telegram game creation and registration handlers

**Files:**
- Create: `packages/telegram/src/callbacks/callback-codec.ts`
- Create: `packages/telegram/src/games/game-creation.handlers.ts`
- Create: `packages/telegram/src/games/game-management.handlers.ts`
- Create: `packages/telegram/src/registrations/registration.handlers.ts`
- Create: `packages/telegram/src/registrations/guest-flow.handlers.ts`
- Create: `packages/telegram/src/messages/game-preview.renderer.ts`
- Modify: `packages/telegram/src/index.ts`
- Modify: `apps/api/src/telegram/telegram.module.ts`
- Test: `packages/telegram/src/callbacks/callback-codec.spec.ts`
- Test: `packages/telegram/src/games/game-creation.e2e.spec.ts`
- Test: `packages/telegram/src/registrations/registration.e2e.spec.ts`

**Interfaces:**
- Consumes: game and registration use cases from Tasks 2 and 4.
- Produces: versioned callback format `v1:<action>:<opaqueGameId>` with a server-side lookup for all trusted data.
- Produces: private template/scratch creation wizard and group registration callbacks.

- [ ] **Step 1: Write failing callback and end-to-end tests**

```ts
it('does not encode roles or priority in callbacks', () => {
  const value = codec.encode({ version: 1, action: 'GOING', gameId });
  expect(value).toMatch(/^v1:go:/);
  expect(value).not.toContain('ADMIN');
  expect(value).not.toContain('MEMBER');
});

it('registers the callback sender for the referenced game only', async () => {
  await harness.sendCallback({ from: user42, data: codec.going(gameA) });
  expect(await harness.registrationState(gameA, user42)).toBe('ROSTERED');
  expect(await harness.registrationState(gameB, user42)).toBeNull();
});
```

Cover template selection, scratch creation, preview-before-publish, guest name requirement, tentative action, withdrawal, unauthorized management, and stale game buttons.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/telegram/src/callbacks packages/telegram/src/games packages/telegram/src/registrations`

Expected: FAIL because handlers and codec are missing.

- [ ] **Step 3: Implement private creation flow and group callbacks**

Creation state is persisted; no wizard relies solely on grammY memory sessions. `Publish` calls `CreateGame` only after the preview contains venue, local date/time, capacity, registration opening, confirmation timing, and cost defaults.

Map callbacks to use cases without business logic:

```ts
bot.callbackQuery(/^v1:go:/, async (ctx) => {
  const action = codec.decode(ctx.callbackQuery.data);
  const result = await registerParticipant.execute({
    groupId: await gameGroupResolver.resolve(action.gameId),
    gameId: action.gameId,
    telegramUserId: String(ctx.from.id),
    intent: 'CONFIRMED',
    idempotencyKey: `callback:${ctx.update.update_id}`,
  });
  await ctx.answerCallbackQuery({ text: statusText(result) });
});
```

`Add guest` sends a signed deep link to a private name-entry flow. Reject blank names and names longer than 80 Unicode code points.

- [ ] **Step 4: Run milestone verification**

Run: `pnpm vitest run packages/telegram/src/callbacks packages/telegram/src/games packages/telegram/src/registrations`

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: all commands exit 0.

- [ ] **Step 5: Commit Telegram game and registration flows**

```bash
git add packages/telegram apps/api packages/application packages/contracts
git commit -m "feat: add Telegram game and registration flows"
```

## Milestone Acceptance

Using synthetic Telegram updates and PostgreSQL, verify that two groups can each create templates and games, participants can register or withdraw, guests require names, tentative users remain outside capacity, simultaneous final-place attempts create one roster entry, and waitlist promotion follows the approved priority policy.
