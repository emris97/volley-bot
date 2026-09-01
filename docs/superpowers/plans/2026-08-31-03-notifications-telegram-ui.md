# Notifications and Canonical Telegram UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver reliable scheduled state changes, canonical game-message updates, tentative confirmation, reminders, waitlist promotion notifications, and delivery recovery.

**Architecture:** PostgreSQL outbox rows are claimed by a dispatcher and submitted as deterministic BullMQ jobs. Workers re-read authoritative state before acting, making jobs idempotent and allowing Redis queues to be rebuilt after failure.

**Tech Stack:** Node.js 24 LTS, TypeScript 5.9.3, NestJS 11.1.28, grammY 1.45.1, BullMQ 6.0.5, Redis 8, PostgreSQL 16, Vitest 4.1.10, Testcontainers 12.0.4

**Spec:** `docs/superpowers/specs/2026-08-31-volleyball-bot-design.md`

## Global Constraints

- Complete plans 01 and 02 first.
- PostgreSQL remains authoritative for business and scheduling intent.
- Every background job has a deterministic ID and may run more than once safely.
- Workers re-check current game and registration state before side effects.
- Private delivery is preferred; unavailable private delivery falls back to a consolidated group mention.
- Cancelling or rescheduling a game invalidates obsolete jobs.
- Follow TDD and commit after every task.

---

### Task 1: Implement transactional outbox claiming and BullMQ dispatch

**Files:**
- Create: `packages/application/src/outbox/outbox-dispatcher.ts`
- Create: `packages/application/src/outbox/outbox-event.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/persistence/src/repositories/outbox.repository.ts`
- Modify: `packages/persistence/src/schema/outbox.ts`
- Create: `packages/persistence/migrations/0006_outbox_leases.sql`
- Modify: `packages/persistence/src/index.ts`
- Create: `apps/worker/src/outbox/outbox.module.ts`
- Create: `apps/worker/src/outbox/outbox.consumer.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Test: `packages/persistence/src/repositories/outbox.repository.int.spec.ts`
- Test: `apps/worker/src/outbox/outbox.consumer.spec.ts`

**Interfaces:**
- Produces: `OutboxRepository.claimBatch(limit, leaseUntil)`, `markPublished(id)`, and `release(id, error)`.
- Produces: `JobPublisher.publish({ id, type, payload, occurredAt })`.
- Produces: deterministic BullMQ job ID `outbox:<outboxEventId>`.

- [ ] **Step 1: Write failing lease and duplicate-publish tests**

```ts
it('does not let two dispatchers claim the same event', async () => {
  const [first, second] = await Promise.all([
    repo.claimBatch(10, addMinutes(now, 1)),
    repo.claimBatch(10, addMinutes(now, 1)),
  ]);
  expect([...first, ...second].map((item) => item.id)).toHaveLength(
    new Set([...first, ...second].map((item) => item.id)).size,
  );
});

it('publishes retries with the same BullMQ job id', async () => {
  await dispatcher.dispatchOnce();
  await dispatcher.dispatchOnce();
  expect(publisher.publish).toHaveBeenCalledWith(
    expect.objectContaining({ id: `outbox:${eventId}` }),
  );
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/persistence/src/repositories/outbox.repository.int.spec.ts apps/worker/src/outbox/outbox.consumer.spec.ts`

Expected: FAIL because claim and dispatch implementations are absent.

- [ ] **Step 3: Implement lease-based claiming and publishing**

Add `claim_expires_at` and `last_error` to the outbox schema in migration `0004_outbox_leases.sql`. Claim rows with `FOR UPDATE SKIP LOCKED`, set `claimed_at` and `claim_expires_at`, then commit before publishing. A failed publish increments `attempt_count`, records a bounded error message, and clears the claim for retry. A successful publish sets `published_at`.

Use BullMQ options:

```ts
await queue.add(event.type, event.payload, {
  jobId: `outbox:${event.id}`,
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800 },
});
```

- [ ] **Step 4: Run focused and static verification**

Run: `pnpm vitest run packages/persistence/src/repositories/outbox.repository.int.spec.ts apps/worker/src/outbox/outbox.consumer.spec.ts`

Run: `pnpm typecheck && pnpm lint`

Expected: tests pass and static checks exit 0.

- [ ] **Step 5: Commit outbox dispatch**

```bash
git add packages/application packages/persistence apps/worker
git commit -m "feat: dispatch transactional outbox events"
```

---

### Task 2: Schedule and reconcile game lifecycle jobs

**Files:**
- Create: `packages/application/src/scheduling/schedule-policy.ts`
- Create: `packages/application/src/scheduling/reconcile-game-jobs.ts`
- Modify: `packages/application/src/index.ts`
- Create: `apps/worker/src/scheduling/game-scheduler.consumer.ts`
- Create: `apps/worker/src/scheduling/game-scheduler.module.ts`
- Create: `packages/persistence/src/schema/scheduled-jobs.ts`
- Modify: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/migrations/0007_scheduled_jobs.sql`
- Create: `packages/persistence/src/repositories/scheduled-job.repository.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Test: `packages/application/src/scheduling/schedule-policy.spec.ts`
- Test: `apps/worker/src/scheduling/game-scheduler.consumer.int.spec.ts`

**Interfaces:**
- Produces: `requiredJobsForGame(game, registrations): RequiredJob[]`.
- Produces job kinds `OPEN_REGISTRATION`, `CLOSE_REGISTRATION`, `REQUEST_TENTATIVE_CONFIRMATION`, `EXPIRE_TENTATIVE`, and `REMIND_PARTICIPANTS`.
- Produces deterministic job ID `<kind>:<gameId>:<scheduleRevision>`.

- [ ] **Step 1: Write failing schedule-policy tests**

```ts
it('does not schedule participant reminders for a cancelled game', () => {
  expect(requiredJobsForGame(cancelledGame, []).map((job) => job.kind)).toEqual([]);
});

it('changes all time-based job ids when the schedule revision changes', () => {
  const before = requiredJobsForGame({ ...game, scheduleRevision: 1 }, []);
  const after = requiredJobsForGame({ ...game, scheduleRevision: 2 }, []);
  expect(after.map((job) => job.id)).not.toEqual(before.map((job) => job.id));
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/scheduling/schedule-policy.spec.ts apps/worker/src/scheduling/game-scheduler.consumer.int.spec.ts`

Expected: FAIL because schedule reconciliation is missing.

- [ ] **Step 3: Implement desired-state reconciliation**

`requiredJobsForGame` returns pure desired state. Migration `0005_scheduled_jobs.sql` creates tenant-scoped `scheduled_jobs` metadata with unique `(game_id, deterministic_job_id)`. `ReconcileGameJobs` compares desired state to those rows, adds missing BullMQ delayed jobs, and removes obsolete jobs.

Workers must use a compare-and-transition operation:

```ts
await games.withLockedGame(groupId, gameId, async (game, tx) => {
  if (game.scheduleRevision !== expectedRevision || game.state !== expectedState) return;
  await games.transition(tx, game, targetState);
  await outbox.append(tx, gameStateChangedEvent(game, targetState));
});
```

Add a periodic reconciliation pass that scans nonterminal games in bounded pages and recreates missing jobs after Redis loss.

- [ ] **Step 4: Verify scheduling and stale-job behavior**

Run: `pnpm vitest run packages/application/src/scheduling apps/worker/src/scheduling`

Run: `pnpm typecheck && pnpm lint`

Expected: scheduled transitions occur once, and old-revision jobs have no effect.

- [ ] **Step 5: Commit scheduling**

```bash
git add packages/application packages/persistence apps/worker
git commit -m "feat: reconcile scheduled game jobs"
```

---

### Task 3: Render and maintain the canonical game message

**Files:**
- Create: `packages/telegram/src/messages/game-message.model.ts`
- Create: `packages/telegram/src/messages/game-message.renderer.ts`
- Create: `packages/telegram/src/messages/game-message-updater.ts`
- Modify: `packages/application/src/ports/telegram.gateway.ts`
- Create: `apps/worker/src/telegram/game-message.consumer.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Test: `packages/telegram/src/messages/game-message.renderer.spec.ts`
- Test: `packages/telegram/src/messages/game-message-updater.spec.ts`

**Interfaces:**
- Produces: `GameMessageView`, `renderGameMessage(view): RenderedTelegramMessage`, and `GameMessageUpdater.refresh(groupId, gameId)`.
- Consumes: `TelegramGateway.editMessage`, `sendMessage`, and optional `pinMessage`.

- [ ] **Step 1: Write failing rendering and replacement tests**

```ts
it('renders roster, waitlist, and tentative counts from one view model', () => {
  const rendered = renderGameMessage(view({ roster: 12, capacity: 14, waitlist: 3, tentative: 2 }));
  expect(rendered.text).toContain('Состав: 12/14');
  expect(rendered.text).toContain('Резерв: 3');
  expect(rendered.text).toContain('Не уверены: 2');
});

it('creates and stores a replacement when Telegram cannot edit the old message', async () => {
  telegram.editMessage.mockRejectedValue(new TelegramMessageNotEditableError());
  telegram.sendMessage.mockResolvedValue({ messageId: '9001' });
  await updater.refresh(groupId, gameId);
  expect(games.setCanonicalMessageId).toHaveBeenCalledWith(groupId, gameId, '9001');
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/telegram/src/messages/game-message.renderer.spec.ts packages/telegram/src/messages/game-message-updater.spec.ts`

Expected: FAIL because renderer and updater do not exist.

- [ ] **Step 3: Implement pure rendering and idempotent replacement**

Build one `GameMessageView` query in the application layer. Escape all user-controlled Telegram HTML. Render buttons from game state and viewer-independent actions only:

```ts
const keyboard = game.state === 'OPEN'
  ? [[button('Иду', go(game.id)), button('Не уверен', tentative(game.id))],
     [button('Добавить гостя', addGuest(game.id))],
     [button('Управление', manage(game.id))]]
  : [[button('Управление', manage(game.id))]];
```

Serialize refreshes per game with deterministic BullMQ job IDs and re-read state immediately before rendering. Persist the replacement message ID in a transaction and optionally pin it according to group settings.

- [ ] **Step 4: Run rendering and updater verification**

Run: `pnpm vitest run packages/telegram/src/messages`

Run: `pnpm typecheck && pnpm lint`

Expected: rendering is deterministic and replacement tests pass.

- [ ] **Step 5: Commit canonical message support**

```bash
git add packages/telegram packages/application packages/persistence apps/worker
git commit -m "feat: maintain canonical game messages"
```

---

### Task 4: Implement tentative confirmation and delivery fallback

**Files:**
- Create: `packages/application/src/registrations/confirm-tentative.ts`
- Create: `packages/application/src/registrations/expire-tentative.ts`
- Create: `packages/application/src/notifications/notification-policy.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/telegram/src/notifications/notification.renderer.ts`
- Create: `packages/telegram/src/notifications/notification.sender.ts`
- Create: `packages/telegram/src/registrations/tentative.handlers.ts`
- Modify: `packages/application/src/ports/telegram.gateway.ts`
- Create: `apps/worker/src/notifications/notification.consumer.ts`
- Modify: `apps/worker/src/worker.module.ts`
- Test: `packages/application/src/registrations/confirm-tentative.spec.ts`
- Test: `packages/telegram/src/notifications/notification.sender.spec.ts`

**Interfaces:**
- Produces: `ConfirmTentative.execute`, `ExpireTentative.execute`, and `NotificationSender.send(intent)`.
- Produces: notification target resolution `PRIVATE`, `GROUP_MENTION`, or `INVITER_PRIVATE`.

- [ ] **Step 1: Write failing transition and fallback tests**

```ts
it('uses confirmation time when placing a tentative participant', async () => {
  clock.set('2026-09-01T12:00:00.000Z');
  const result = await confirm.execute({ groupId, gameId, registrationId, actorUserId });
  expect(result.confirmedAt).toEqual(new Date('2026-09-01T12:00:00.000Z'));
});

it('falls back to a group mention when private delivery is forbidden', async () => {
  telegram.sendPrivate.mockRejectedValue(new TelegramPrivateChatUnavailableError());
  await sender.send(intentFor(user));
  expect(telegram.sendGroupMessage).toHaveBeenCalledWith(
    groupChatId,
    expect.stringContaining('tg://user?id=42'),
  );
});
```

Also test guest routing through inviter, expiry without response, response after expiry, and idempotent confirmation.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/registrations/confirm-tentative.spec.ts packages/telegram/src/notifications/notification.sender.spec.ts`

Expected: FAIL because confirmation and sender logic are absent.

- [ ] **Step 3: Implement transitions and consolidated fallback**

Confirmation and expiry use the same locked transaction coordinator as registration. An expiry job cancels only a still-`TENTATIVE` registration whose confirmation revision matches the job.

Private delivery failure updates `users.dm_available_at` to null and creates a fallback intent. Batch fallback mentions by `(groupId, gameId, notificationType)` to avoid one noisy group message per user. Guests are addressed through the inviter.

- [ ] **Step 4: Run focused and full notification verification**

Run: `pnpm vitest run packages/application/src/registrations packages/telegram/src/notifications apps/worker/src/notifications`

Run: `pnpm typecheck && pnpm lint`

Expected: all commands exit 0.

- [ ] **Step 5: Commit tentative confirmation and fallback**

```bash
git add packages/application packages/telegram packages/persistence apps/worker
git commit -m "feat: confirm tentative registrations reliably"
```

---

### Task 5: Prove notification recovery end to end

**Files:**
- Create: `tests/e2e/notification-lifecycle.e2e.spec.ts`
- Create: `tests/e2e/fixtures/telegram-gateway.fake.ts`
- Create: `tests/e2e/fixtures/test-clock.ts`
- Create: `tests/e2e/fixtures/test-system.ts`
- Create: `scripts/reconcile-jobs.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm jobs:reconcile` operational command.
- Produces: reusable E2E harness for the final milestone.

- [ ] **Step 1: Write the failing recovery scenario**

```ts
it('rebuilds jobs and converges Telegram state after Redis loss', async () => {
  const game = await system.createScheduledGame({ capacity: 1 });
  await system.registerTentative(game, userA);
  await system.flushRedis();
  await system.reconcileJobs();
  await system.clock.advanceTo(game.confirmationRequestAt);
  await system.drainWorkers();

  expect(system.telegram.privateMessagesFor(userA)).toContainEqual(
    expect.objectContaining({ buttons: ['Подтверждаю', 'Снимаюсь'] }),
  );
  expect(await system.pendingRequiredJobs(game.id)).toEqual([]);
});
```

- [ ] **Step 2: Verify the scenario fails**

Run: `pnpm vitest run tests/e2e/notification-lifecycle.e2e.spec.ts`

Expected: FAIL until the reconciliation command and full harness are wired.

- [ ] **Step 3: Implement the recovery command and complete harness wiring**

`scripts/reconcile-jobs.ts` boots a minimal Nest application context, runs paginated desired-state reconciliation, prints structured counts, and exits nonzero when any page fails. It must not start the Telegram webhook server.

- [ ] **Step 4: Run milestone verification**

Run: `pnpm vitest run tests/e2e/notification-lifecycle.e2e.spec.ts`

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: recovery scenario and full suite pass.

- [ ] **Step 5: Commit recovery coverage**

```bash
git add tests/e2e scripts/reconcile-jobs.ts package.json
git commit -m "test: cover notification recovery lifecycle"
```

## Milestone Acceptance

The milestone is complete when scheduled opening, closing, confirmation requests, expiry, reminders, promotions, cancellation, and message refreshes survive duplicate jobs and Redis loss while PostgreSQL and Telegram converge on one authoritative game state.
