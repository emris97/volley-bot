# Attendance, Payments, API Boundaries, and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete post-game attendance and cost splitting, manual payment tracking, future-client authentication boundaries, observability, container portability, and MVP acceptance coverage.

**Architecture:** Attendance and settlement are immutable domain snapshots persisted transactionally. Versioned HTTP contracts expose existing application services to future clients, while adapters validate Telegram Mini App identity or future web identity without duplicating authorization rules.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9.3, NestJS 11.1.28, Fastify 5.11.0, grammY 1.45.1, PostgreSQL 16, Redis 8, BullMQ 6.0.5, Vitest 4.1.10, fast-check 4.9.0, Docker

**Spec:** `docs/superpowers/specs/2026-08-31-volleyball-bot-design.md`

## Global Constraints

- Complete plans 01 through 03 first.
- The administrator enters total game cost; the backend calculates participant charges.
- A finalized settlement is immutable; corrections create an audited replacement revision.
- Participants cannot mark their own charges paid.
- Mini App authentication trusts only validated raw `initData` and checks freshness.
- Future clients call the same application services as Telegram handlers.
- Deployment remains provider-neutral and containers store no durable local state.
- Follow TDD and commit after every task.

---

### Task 1: Confirm actual attendance

**Files:**
- Create: `packages/domain/src/attendance/attendance.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/persistence/src/schema/attendance.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/migrations/0009_attendance.sql`
- Create: `packages/application/src/attendance/confirm-attendance.ts`
- Create: `packages/application/src/attendance/ports.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/repositories/attendance.repository.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/telegram/src/attendance/attendance.handlers.ts`
- Test: `packages/application/src/attendance/confirm-attendance.spec.ts`
- Test: `packages/telegram/src/attendance/attendance.e2e.spec.ts`

**Interfaces:**
- Produces: `AttendanceEntry { participantRef; sourceRegistrationId?; billable; addedManually; }`.
- Produces: `ConfirmAttendance.execute(command): AttendanceSnapshot`.

- [ ] **Step 1: Write failing attendance tests**

```ts
it('starts from the final roster and permits explicit corrections', async () => {
  const snapshot = await useCase.execute({
    groupId,
    gameId,
    actorUserId: organizer,
    excludedRegistrationIds: [absentRegistrationId],
    manualParticipants: [{ displayName: 'Late player', billable: true }],
  });

  expect(snapshot.entries.some((entry) => entry.sourceRegistrationId === absentRegistrationId)).toBe(false);
  expect(snapshot.entries).toContainEqual(expect.objectContaining({ displayName: 'Late player' }));
});

it('rejects attendance confirmation before completion', async () => {
  await expect(useCase.execute(commandFor(openGame))).rejects.toThrow(/game must be completed/i);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/attendance/confirm-attendance.spec.ts packages/telegram/src/attendance/attendance.e2e.spec.ts`

Expected: FAIL because attendance model and flow are missing.

- [ ] **Step 3: Implement attendance snapshots and Telegram correction flow**

Create `attendance_snapshots` and `attendance_entries`. `ConfirmAttendance` requires `ORGANIZER` or stronger, locks the completed game, copies the final roster, applies explicit exclusions/additions, writes audit/outbox events, and returns a preview until the administrator confirms.

Use a revisioned command:

```ts
export interface ConfirmAttendanceCommand {
  groupId: GroupId;
  gameId: GameId;
  actorUserId: UserId;
  expectedRevision: number;
  excludedRegistrationIds: RegistrationId[];
  manualParticipants: Array<{ displayName: string; billable: boolean }>;
  finalize: boolean;
}
```

The Telegram flow presents roster entries as toggle buttons, then asks for final confirmation. Stale revisions reload the latest preview instead of overwriting another administrator's change.

- [ ] **Step 4: Run focused and static verification**

Run: `pnpm vitest run packages/application/src/attendance packages/telegram/src/attendance`

Run: `pnpm typecheck && pnpm lint`

Expected: tests pass and static checks exit 0.

- [ ] **Step 5: Commit attendance**

```bash
git add packages/domain packages/application packages/persistence packages/telegram
git commit -m "feat: add post-game attendance confirmation"
```

---

### Task 2: Implement exact and rounded cost splitting

**Files:**
- Create: `packages/domain/src/payments/money.ts`
- Create: `packages/domain/src/payments/settlement.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/payments/settlement.spec.ts`
- Test: `packages/domain/src/payments/settlement.property.spec.ts`

**Interfaces:**
- Produces: `Money { amountMinor: bigint; currency: 'RUB' }`.
- Produces: `RoundingMode = 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50'`.
- Produces: `calculateSettlement(input): SettlementCalculation`.

- [ ] **Step 1: Write failing examples and invariants**

```ts
it('distributes an exact minor-unit remainder deterministically', () => {
  const result = calculateSettlement({
    total: rubles('2800.00'),
    participantIds: ['a', 'b', 'c'],
    roundingMode: 'EXACT',
  });
  expect(result.charges.map((charge) => charge.amountMinor)).toEqual([93334n, 93333n, 93333n]);
  expect(result.collectedMinor).toBe(280000n);
  expect(result.surplusMinor).toBe(0n);
});

it('reports surplus when every charge is rounded upward', () => {
  const result = calculateSettlement({
    total: rubles('2800.00'),
    participantIds: Array.from({ length: 18 }, (_, index) => String(index)),
    roundingMode: 'UP_10',
  });
  expect(result.charges.every((charge) => charge.amountMinor === 16000n)).toBe(true);
  expect(result.surplusMinor).toBe(8000n);
});
```

Property tests must assert exact totals for `EXACT`, nonnegative surplus for upward modes, equal charges for upward modes, deterministic output regardless of input array identity, rejection of zero participants, and no floating-point arithmetic.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/domain/src/payments/settlement.spec.ts packages/domain/src/payments/settlement.property.spec.ts`

Expected: FAIL because money and settlement functions are absent.

- [ ] **Step 3: Implement integer-only allocation**

```ts
export function calculateSettlement(input: SettlementInput): SettlementCalculation {
  if (input.participantIds.length === 0) throw new Error('At least one participant is required');
  const orderedIds = input.participantIds.toSorted();
  const count = BigInt(orderedIds.length);
  const base = input.total.amountMinor / count;
  const remainder = input.total.amountMinor % count;

  const charges = input.roundingMode === 'EXACT'
    ? orderedIds.map((participantId, index) => ({
        participantId,
        amountMinor: base + (BigInt(index) < remainder ? 1n : 0n),
      }))
    : equalRoundedCharges(orderedIds, roundUp(base, stepMinor(input.roundingMode)));

  const collectedMinor = charges.reduce((sum, charge) => sum + charge.amountMinor, 0n);
  return { charges, collectedMinor, surplusMinor: collectedMinor - input.total.amountMinor };
}
```

Parse user-entered money as a decimal string and reject more than two fractional digits. Never convert monetary amounts through JavaScript `number`.

- [ ] **Step 4: Run all settlement tests**

Run: `pnpm vitest run packages/domain/src/payments`

Expected: examples and property tests pass.

- [ ] **Step 5: Commit settlement domain**

```bash
git add packages/domain/src/payments packages/domain/src/index.ts
git commit -m "feat: calculate game cost per participant"
```

---

### Task 3: Persist settlements and manual payment status

**Files:**
- Create: `packages/persistence/src/schema/payments.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/migrations/0010_payments.sql`
- Create: `packages/application/src/payments/ports.ts`
- Create: `packages/application/src/payments/preview-settlement.ts`
- Create: `packages/application/src/payments/finalize-settlement.ts`
- Create: `packages/application/src/payments/change-charge-status.ts`
- Create: `packages/application/src/payments/send-payment-reminders.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/repositories/payment.repository.ts`
- Create: `packages/telegram/src/payments/payment.handlers.ts`
- Test: `packages/application/src/payments/finalize-settlement.spec.ts`
- Test: `packages/application/src/payments/change-charge-status.spec.ts`
- Test: `packages/telegram/src/payments/payment.e2e.spec.ts`

**Interfaces:**
- Produces: `ChargeStatus = 'UNPAID' | 'PAID' | 'WAIVED'`.
- Produces: `PreviewSettlement`, `FinalizeSettlement`, `ChangeChargeStatus`, and `SendPaymentReminders` use cases.

- [ ] **Step 1: Write failing settlement and authorization tests**

```ts
it('persists one immutable charge per billable attendee', async () => {
  const settlement = await finalize.execute({
    groupId,
    gameId,
    actorUserId: organizer,
    attendanceRevision: 1,
    totalAmount: '2800.00',
    currency: 'RUB',
    roundingMode: 'UP_10',
  });
  expect(settlement.charges).toHaveLength(18);
  expect(settlement.surplusMinor).toBe(8000n);
});

it('does not let a participant mark their own charge paid', async () => {
  await expect(changeStatus.execute({
    groupId,
    chargeId,
    actorUserId: participant,
    status: 'PAID',
  })).rejects.toThrow(/organizer permission required/i);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/payments packages/telegram/src/payments/payment.e2e.spec.ts`

Expected: FAIL because payment persistence and flows are missing.

- [ ] **Step 3: Implement revisioned settlement snapshots and admin UI**

Create `settlements`, `settlement_charges`, and `charge_status_events`. Store totals and charges as `BIGINT` minor units, currency, rounding mode, allocation order, surplus, attendance revision, settlement revision, actor, and timestamps.

Finalization locks game and attendance records. A correction does not mutate the old snapshot: it creates revision `n + 1`, marks revision `n` superseded, and produces new charges in one transaction.

The private Telegram management flow is:

1. enter total cost as decimal text;
2. preview participant count, per-person charges, total collection, and surplus;
3. confirm finalization;
4. display charges with `Оплачено`, `Не оплачено`, and `Оплата не требуется` controls;
5. send selected private reminders on explicit administrator action.

- [ ] **Step 4: Run payment and static verification**

Run: `pnpm vitest run packages/application/src/payments packages/telegram/src/payments`

Run: `pnpm typecheck && pnpm lint`

Expected: payment flows pass and no participant can self-confirm payment.

- [ ] **Step 5: Commit payment tracking**

```bash
git add packages/application packages/persistence packages/telegram
git commit -m "feat: add settlement and payment tracking"
```

---

### Task 4: Expose future-client contracts and Mini App authentication

**Files:**
- Create: `packages/contracts/src/v1/groups.ts`
- Create: `packages/contracts/src/v1/games.ts`
- Create: `packages/contracts/src/v1/registrations.ts`
- Create: `packages/contracts/src/v1/payments.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/application/src/auth/authenticated-principal.ts`
- Create: `packages/application/src/auth/authorization.service.ts`
- Create: `apps/api/src/auth/mini-app-init-data.verifier.ts`
- Create: `apps/api/src/auth/auth.guard.ts`
- Create: `apps/api/src/v1/games.controller.ts`
- Create: `apps/api/src/v1/v1.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/auth/mini-app-init-data.verifier.spec.ts`
- Test: `apps/api/src/v1/games.controller.e2e.spec.ts`

**Interfaces:**
- Produces: `AuthenticatedPrincipal { userId; telegramUserId; source: 'TELEGRAM_BOT' | 'MINI_APP' | 'WEB'; }`.
- Produces: versioned Zod request/response schemas under `@volley/contracts/v1`.
- Produces: `AuthorizationService.requireRole(groupId, principal, minimumRole)` shared by every adapter.

- [ ] **Step 1: Write failing signature, freshness, and tenant tests**

```ts
it('rejects validly shaped init data with an invalid signature', () => {
  expect(() => verifier.verify(tamperedInitData, now)).toThrow(/signature/i);
});

it('rejects init data older than five minutes', () => {
  expect(() => verifier.verify(signedInitData({ authDate: fiveMinutesAgo - 1 }), now)).toThrow(/expired/i);
});

it('does not return a game belonging to another group', async () => {
  const response = await request(app)
    .get(`/api/v1/groups/${groupB}/games/${gameInGroupA}`)
    .set(validMiniAppAuthorizationFor(groupB));
  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/api/src/auth/mini-app-init-data.verifier.spec.ts apps/api/src/v1/games.controller.e2e.spec.ts`

Expected: FAIL because verifier, guard, and versioned controller are absent.

- [ ] **Step 3: Implement adapter-neutral principal and minimal read API**

Validate raw Telegram `initData` with HMAC-SHA-256, compare signatures with a timing-safe function, and enforce a five-minute maximum age. Never accept `initDataUnsafe`.

The first API endpoint is deliberately small:

```ts
@Get('/groups/:groupId/games/:gameId')
async getGame(@Principal() principal: AuthenticatedPrincipal, @Param() params: GameParams) {
  await this.authorization.requireRole(params.groupId, principal, 'MEMBER');
  return GameResponseSchema.parse(await this.queries.getGame(params.groupId, params.gameId));
}
```

Do not implement a frontend. The endpoint proves that versioned contracts and non-Telegram-controller authentication can call existing application services without duplicated business rules.

- [ ] **Step 4: Run API and security verification**

Run: `pnpm vitest run apps/api/src/auth apps/api/src/v1`

Run: `pnpm typecheck && pnpm lint`

Expected: signature, freshness, authorization, and cross-tenant tests pass.

- [ ] **Step 5: Commit future-client boundary**

```bash
git add packages/contracts packages/application/src/auth apps/api/src/auth apps/api/src/v1 apps/api/src/app.module.ts
git commit -m "feat: add versioned API and Mini App auth boundary"
```

---

### Task 5: Add observability, portable containers, and MVP acceptance tests

**Files:**
- Create: `packages/application/src/observability/logger.ts`
- Create: `packages/application/src/observability/metrics.ts`
- Create: `apps/api/Dockerfile`
- Create: `apps/worker/Dockerfile`
- Create: `docker/entrypoint-api.sh`
- Create: `docker/entrypoint-worker.sh`
- Modify: `compose.yaml`
- Modify: `.env.example`
- Create: `tests/e2e/mvp-acceptance.e2e.spec.ts`
- Create: `tests/e2e/security.e2e.spec.ts`
- Create: `scripts/migrate.ts`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: structured logger fields `correlationId`, `updateId`, `groupId`, `gameId`, and `jobId`.
- Produces: `/health/live`, `/health/ready`, and `/metrics`.
- Produces: `pnpm db:migrate` and provider-neutral API/worker images.

- [ ] **Step 1: Write failing MVP and security acceptance tests**

```ts
it('completes the multi-group MVP journey with isolated state', async () => {
  const [groupA, groupB] = await system.onboardTwoGroups();
  const game = await system.publishTemplateGame(groupA, { capacity: 1, totalCost: '1300.00' });
  await system.registerMember(game, userA);
  await system.registerGuest(game, userB, 'Guest');
  expect(await system.gameView(groupA, game)).toMatchObject({ rosterCount: 1, waitlistCount: 1 });
  expect(await system.listGames(groupB)).toEqual([]);

  await system.withdraw(game, userA);
  expect(await system.registrationState(game, 'Guest')).toBe('ROSTERED');

  await system.completeAndConfirmAttendance(game);
  const settlement = await system.finalizeSettlement(game, '1300.00', 'EXACT');
  expect(settlement.charges).toHaveLength(1);
});

it('redacts secrets and rejects cross-group identifiers', async () => {
  await system.triggerInvalidWebhookWithKnownToken();
  expect(system.logs()).not.toContain(process.env.BOT_TOKEN);
  expect(await system.crossTenantRequest()).toHaveStatus(404);
});
```

Map each of the 12 acceptance criteria in the design spec to a named test in this file.

Use these exact test names:

1. `administrator self-onboards an unconfigured group`;
2. `two groups keep settings and data isolated`;
3. `organizer publishes template and scratch games`;
4. `participant manages self guest and tentative registrations without free text`;
5. `concurrent final-place clicks produce one roster entry`;
6. `member priority and audited administrator override are deterministic`;
7. `tentative registration is prompted and expires without response`;
8. `withdrawal promotes and notifies the first eligible waiter`;
9. `canonical message converges after duplicate and rapid changes`;
10. `administrator confirms attendance splits total cost and marks payments`;
11. `Redis loss and duplicate updates preserve authoritative state`;
12. `Mini App API calls the same authorized application services`.

- [ ] **Step 2: Verify acceptance tests fail**

Run: `pnpm vitest run tests/e2e/mvp-acceptance.e2e.spec.ts tests/e2e/security.e2e.spec.ts`

Expected: FAIL until observability, migration command, and complete system harness are wired.

- [ ] **Step 3: Implement observability and portable images**

Use JSON logs with explicit redaction for `BOT_TOKEN`, webhook secrets, database credentials, raw Mini App init data, and authorization headers. Expose counters and histograms for webhook results, queue depth, retries, outbox lag, notification failures, and transaction conflicts. Document retention periods for guest display names, delivery attempts, application logs, business audit events, and payment records in `README.md`; choose conservative finite defaults for operational data and state that legal/accounting review is required before public launch.

Both Dockerfiles use a Node 24 multi-stage build, run as a non-root user, contain only production dependencies and compiled output, and use the matching entrypoint. The API entrypoint runs migrations once through an explicit deployment command, not independently in every horizontally scaled API process.

Update Compose to run `api`, `worker`, PostgreSQL, and Redis with health-based dependencies. No application volume may hold durable business data.

- [ ] **Step 4: Run the complete release gate**

Run: `pnpm test`

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm build`

Run: `docker compose config`

Run: `docker compose build api worker`

Run: `docker compose up -d postgres redis && pnpm db:migrate`

Run: `pnpm vitest run tests/e2e/mvp-acceptance.e2e.spec.ts tests/e2e/security.e2e.spec.ts`

Expected: every command exits 0, all 12 spec acceptance criteria have passing tests, and both images build.

- [ ] **Step 5: Commit release hardening**

```bash
git add packages/application apps docker compose.yaml .env.example tests/e2e scripts/migrate.ts README.md package.json pnpm-lock.yaml
git commit -m "feat: complete volleyball bot MVP foundation"
```

## Milestone Acceptance

The milestone and MVP are complete only when the full release gate passes, all design acceptance criteria have named tests, cost splitting uses integer minor units, payment status is administrator-controlled, Mini App authentication rejects tampering and stale data, logs redact secrets, and API/worker images build without provider-specific assumptions.
