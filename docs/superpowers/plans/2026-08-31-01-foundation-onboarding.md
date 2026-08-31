# Foundation and Group Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the TypeScript/NestJS monorepo, persistence foundation, secure Telegram webhook, and self-service group onboarding flow.

**Architecture:** A pnpm workspace contains independently runnable API and worker applications plus focused domain, application, persistence, Telegram, configuration, and contract packages. PostgreSQL is authoritative; Telegram is accessed behind a gateway so onboarding can be tested without the network.

**Tech Stack:** Node.js 24 LTS, pnpm 11.19.0, TypeScript 5.9.3, NestJS 11.1.28, Fastify 5.11.0, grammY 1.45.1, Drizzle ORM 0.45.2, PostgreSQL 16, Redis 8, Vitest 4.1.10, Testcontainers 12.0.4

**Spec:** `docs/superpowers/specs/2026-08-31-volleyball-bot-design.md`

## Global Constraints

- Domain and application packages must not import grammY or Telegram context types.
- PostgreSQL is the source of truth; Redis must never contain authoritative group state.
- Every group-owned record and repository operation is tenant-scoped by `groupId`.
- Telegram identifiers are PostgreSQL `BIGINT` values and strings at JavaScript boundaries.
- Privileged actions require a fresh Telegram administrator check.
- Use UTC in storage and an IANA time-zone identifier on each group.
- Follow TDD: observe each focused test fail before adding production code.
- Commit after every task with only that task's files staged.

---

### Task 1: Bootstrap the workspace and quality gates

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.npmrc`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `.prettierrc.json`
- Create: `eslint.config.mjs`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `packages/{application,config,contracts,domain,persistence,telegram}/package.json`
- Create: `packages/{application,config,contracts,domain,persistence,telegram}/tsconfig.json`
- Create: `packages/{application,config,contracts,domain,persistence,telegram}/src/index.ts`
- Test: `tests/workspace.spec.ts`

**Interfaces:**
- Produces: workspace package names `@volley/application`, `@volley/config`, `@volley/contracts`, `@volley/domain`, `@volley/persistence`, and `@volley/telegram`.
- Produces: root commands `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`.

- [ ] **Step 1: Write the failing workspace smoke test**

```ts
// tests/workspace.spec.ts
import { describe, expect, it } from 'vitest';
import { packageMarker as domainMarker } from '@volley/domain';
import { packageMarker as applicationMarker } from '@volley/application';

describe('workspace', () => {
  it('resolves internal packages through workspace aliases', () => {
    expect([domainMarker, applicationMarker]).toEqual(['domain', 'application']);
  });
});
```

- [ ] **Step 2: Run the test and record the expected failure**

Run: `corepack enable && pnpm install && pnpm vitest run tests/workspace.spec.ts`

Expected: FAIL because the workspace manifests and package exports do not exist.

- [ ] **Step 3: Create the workspace manifests and package markers**

Use this root manifest as the dependency baseline:

```json
{
  "name": "volleyball-bot",
  "private": true,
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "test": "vitest run",
    "lint": "eslint .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@nestjs/testing": "11.1.28",
    "@types/node": "24.13.3",
    "@types/supertest": "7.2.1",
    "drizzle-kit": "0.31.10",
    "eslint": "10.8.0",
    "fast-check": "4.9.0",
    "prettier": "3.9.6",
    "supertest": "7.2.2",
    "testcontainers": "12.0.4",
    "tsx": "4.23.1",
    "typescript": "5.9.3",
    "typescript-eslint": "8.65.0",
    "vitest": "4.1.10"
  }
}
```

Each package exports a marker from `src/index.ts`, for example:

```ts
export const packageMarker = 'domain' as const;
```

Configure `tsconfig.base.json` with strict mode, decorators, project references, `moduleResolution: "NodeNext"`, and explicit `paths` entries for every `@volley/*` package. Keep every package composite and declaration-enabled.

Use exact runtime dependencies in the owning workspace package: API (`@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/platform-fastify` 11.1.28/4.0.4 as applicable, `fastify` 5.11.0, `reflect-metadata` 0.2.2, `rxjs` 7.8.2); worker (`@nestjs/common` and `@nestjs/core` 11.1.28, `bullmq` 6.0.5, `ioredis` 6.0.0); config (`zod` 4.4.3); persistence (`drizzle-orm` 0.45.2 and `pg` 8.22.0); Telegram (`grammy` 1.45.1). Internal packages use `workspace:*` dependencies.

- [ ] **Step 4: Install, test, type-check, lint, and build**

Run: `pnpm install`

Run: `pnpm test -- tests/workspace.spec.ts`

Run: `pnpm typecheck && pnpm lint && pnpm build`

Expected: all commands exit 0 and the smoke test reports one passing test.

- [ ] **Step 5: Commit the workspace scaffold**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc .gitignore .prettierrc.json eslint.config.mjs tsconfig.base.json vitest.config.ts apps packages tests/workspace.spec.ts
git commit -m "build: scaffold TypeScript workspace"
```

---

### Task 2: Add validated configuration and local infrastructure

**Files:**
- Create: `.env.example`
- Create: `compose.yaml`
- Create: `packages/config/src/env.ts`
- Modify: `packages/config/src/index.ts`
- Test: `packages/config/src/env.spec.ts`

**Interfaces:**
- Produces: `type AppEnv` and `parseEnv(input: NodeJS.ProcessEnv): AppEnv`.
- Produces: `DATABASE_URL`, `REDIS_URL`, `BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, and `LOG_LEVEL` validation.

- [ ] **Step 1: Write failing environment validation tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/volley',
  REDIS_URL: 'redis://localhost:6379',
  BOT_TOKEN: '123456:abcdefghijklmnopqrstuvwxyzABCDEFG',
  TELEGRAM_WEBHOOK_SECRET: 'a_secure_secret_123',
  PUBLIC_BASE_URL: 'https://bot.example.test',
  LOG_LEVEL: 'info',
};

describe('parseEnv', () => {
  it('returns typed configuration for valid input', () => {
    expect(parseEnv(valid).PUBLIC_BASE_URL).toBe('https://bot.example.test');
  });

  it('rejects missing webhook secrets', () => {
    expect(() => parseEnv({ ...valid, TELEGRAM_WEBHOOK_SECRET: '' })).toThrow(
      /TELEGRAM_WEBHOOK_SECRET/,
    );
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/config/src/env.spec.ts`

Expected: FAIL because `parseEnv` is not implemented.

- [ ] **Step 3: Implement strict Zod configuration**

```ts
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  REDIS_URL: z.url().startsWith('redis://'),
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).max(256),
  PUBLIC_BASE_URL: z.url().startsWith('https://'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
});

export type AppEnv = z.infer<typeof schema>;
export const parseEnv = (input: NodeJS.ProcessEnv): AppEnv => schema.parse(input);
```

Create `compose.yaml` with PostgreSQL 16 and Redis 8 services, named health checks, persistent development volumes, and no application containers yet. `.env.example` must contain non-secret local examples and document that production secrets are injected externally.

- [ ] **Step 4: Run focused and workspace verification**

Run: `pnpm vitest run packages/config/src/env.spec.ts`

Run: `docker compose config`

Run: `pnpm typecheck && pnpm lint`

Expected: tests pass, Compose configuration renders, and static checks exit 0.

- [ ] **Step 5: Commit configuration and infrastructure**

```bash
git add .env.example compose.yaml packages/config
git commit -m "feat: add validated runtime configuration"
```

---

### Task 3: Create the persistence baseline and tenant identities

**Files:**
- Create: `packages/domain/src/identity.ts`
- Create: `packages/domain/src/groups.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/persistence/drizzle.config.ts`
- Create: `packages/persistence/src/client.ts`
- Create: `packages/persistence/src/schema/users.ts`
- Create: `packages/persistence/src/schema/groups.ts`
- Create: `packages/persistence/src/schema/audit.ts`
- Create: `packages/persistence/src/schema/outbox.ts`
- Create: `packages/persistence/src/schema/index.ts`
- Create: `packages/persistence/src/repositories/group.repository.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/persistence/migrations/0001_foundation.sql`
- Test: `packages/persistence/src/repositories/group.repository.int.spec.ts`
- Test: `packages/persistence/src/migrations/migrations.int.spec.ts`

**Interfaces:**
- Produces: branded string types `UserId`, `GroupId`, and `TelegramId`.
- Produces: `GroupRole = 'OWNER' | 'ADMIN' | 'ORGANIZER' | 'MEMBER'`.
- Produces: `GroupRepository.findByTelegramChatId`, `upsertFromTelegram`, `setEnabled`, and `findMembership`.

- [ ] **Step 1: Write the failing repository integration test**

```ts
it('isolates memberships by group', async () => {
  const first = await repo.upsertFromTelegram({
    telegramChatId: '-1001000000001',
    title: 'First',
  });
  const second = await repo.upsertFromTelegram({
    telegramChatId: '-1001000000002',
    title: 'Second',
  });
  await repo.upsertMembership(first.id, '42', 'ADMIN');

  expect(await repo.findMembership(first.id, '42')).toMatchObject({ role: 'ADMIN' });
  expect(await repo.findMembership(second.id, '42')).toBeNull();
});
```

The test must start PostgreSQL with Testcontainers, apply `0001_foundation.sql`, and truncate tables between cases.

- [ ] **Step 2: Verify the integration test fails**

Run: `pnpm vitest run packages/persistence/src/repositories/group.repository.int.spec.ts`

Expected: FAIL because schema and repository do not exist.

- [ ] **Step 3: Implement schema, migration, and repository**

Define these tables with UUID primary keys and timestamps:

- `users(telegram_user_id BIGINT UNIQUE, display_name, dm_available_at)`;
- `groups(telegram_chat_id BIGINT UNIQUE, title, time_zone, enabled, onboarding_state)`;
- `group_members(group_id, user_id, role, membership_status, checked_at)` with unique `(group_id, user_id)`;
- `audit_events(group_id, actor_user_id, event_type, entity_type, entity_id, payload JSONB, created_at)`;
- `outbox_events(group_id, event_type, aggregate_type, aggregate_id, payload JSONB, occurred_at, claimed_at, published_at, attempt_count)`.

Convert Telegram IDs only at the repository boundary:

```ts
const toDatabaseTelegramId = (value: TelegramId): bigint => BigInt(value);
const fromDatabaseTelegramId = (value: bigint): TelegramId => value.toString() as TelegramId;
```

Every group-owned repository query must accept `groupId` explicitly. Do not add an unscoped `findMembershipByUserId` method.

- [ ] **Step 4: Run database and static verification**

Run: `pnpm vitest run packages/persistence/src/repositories/group.repository.int.spec.ts`

Run: `pnpm vitest run packages/persistence/src/migrations/migrations.int.spec.ts`

Run: `pnpm typecheck && pnpm lint`

Expected: repository tests pass, `0001_foundation.sql` applies to a fresh PostgreSQL container, a second migration invocation is a no-op, and static checks exit 0.

- [ ] **Step 5: Commit the persistence baseline**

```bash
git add packages/domain packages/persistence
git commit -m "feat: add tenant-scoped group persistence"
```

---

### Task 4: Bootstrap NestJS API and worker processes

**Files:**
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/health/health.controller.ts`
- Create: `apps/api/src/health/health.service.ts`
- Create: `apps/api/src/health/health.module.ts`
- Create: `apps/api/src/health/health.e2e.spec.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/src/worker.module.ts`
- Create: `apps/worker/src/worker-lifecycle.service.ts`
- Create: `apps/worker/src/worker-lifecycle.spec.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/worker/package.json`
- Modify: `tsconfig.base.json`

**Interfaces:**
- Produces: HTTP `GET /health/live` and `GET /health/ready`.
- Produces: `WorkerLifecycleService.start()` and `stop()` used by later BullMQ workers.

- [ ] **Step 1: Write failing API and worker lifecycle tests**

```ts
it('reports liveness independently from dependencies', async () => {
  const response = await app.inject({ method: 'GET', url: '/health/live' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

it('stops registered consumers during shutdown', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const service = new WorkerLifecycleService([{ start: vi.fn(), stop }]);
  await service.onApplicationShutdown();
  expect(stop).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Verify both tests fail**

Run: `pnpm vitest run apps/api/src/health/health.e2e.spec.ts apps/worker/src/worker-lifecycle.spec.ts`

Expected: FAIL because application bootstraps and lifecycle service are missing.

- [ ] **Step 3: Implement Fastify API and worker bootstraps**

Create the API with `NestFactory.create(AppModule, new FastifyAdapter())`, enable shutdown hooks, and listen on `0.0.0.0`. Readiness must check PostgreSQL and Redis through injectable probes and return 503 when either probe fails. Liveness must not call dependencies.

Define the worker contract:

```ts
export interface ManagedWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

`WorkerLifecycleService` starts consumers on module initialization and closes them in reverse order on shutdown.

- [ ] **Step 4: Run tests, type-check, and build both apps**

Run: `pnpm vitest run apps/api/src/health/health.e2e.spec.ts apps/worker/src/worker-lifecycle.spec.ts`

Run: `pnpm typecheck && pnpm build`

Expected: both tests pass and build outputs are created for API and worker.

- [ ] **Step 5: Commit the runnable processes**

```bash
git add apps package.json pnpm-lock.yaml tsconfig.base.json
git commit -m "feat: bootstrap API and worker processes"
```

---

### Task 5: Implement secure Telegram webhook and self-service onboarding

**Files:**
- Create: `packages/application/src/ports/telegram.gateway.ts`
- Create: `packages/application/src/groups/onboard-group.ts`
- Create: `packages/application/src/groups/configure-group.ts`
- Create: `packages/application/src/groups/change-group-role.ts`
- Modify: `packages/application/src/index.ts`
- Create: `packages/telegram/src/bot.factory.ts`
- Create: `packages/telegram/src/webhook.controller.ts`
- Create: `packages/telegram/src/group-onboarding.handlers.ts`
- Create: `packages/telegram/src/signed-start-token.ts`
- Modify: `packages/telegram/src/index.ts`
- Create: `apps/api/src/telegram/telegram.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `packages/application/src/groups/onboard-group.spec.ts`
- Test: `packages/application/src/groups/change-group-role.spec.ts`
- Test: `packages/telegram/src/signed-start-token.spec.ts`
- Test: `packages/telegram/src/group-onboarding.e2e.spec.ts`

**Interfaces:**
- Consumes: `GroupRepository` from Task 3.
- Produces: `TelegramGateway.getChatMember(chatId, userId)` and `sendMessage(chatId, message)`.
- Produces: `OnboardGroup.execute(command)` and `ConfigureGroup.execute(command)`.
- Produces: `ChangeGroupRole.execute(command)` for granting or revoking `ORGANIZER` without changing Telegram administrator ownership.
- Produces: signed start payload `{ purpose: 'configure-group'; groupId; administratorTelegramId; expiresAt }`.

- [ ] **Step 1: Write failing onboarding and token tests**

```ts
it('allows a verified administrator to begin onboarding', async () => {
  telegram.getChatMember.mockResolvedValue({ status: 'administrator' });
  const result = await useCase.execute({
    telegramChatId: '-1001000000001',
    telegramUserId: '42',
    title: 'Volleyball',
  });
  expect(result.kind).toBe('ONBOARDING_STARTED');
});

it('rejects a tampered configuration token', () => {
  const token = signer.sign(validPayload);
  expect(() => signer.verify(`${token}x`, now)).toThrow(/signature/i);
});

it('disables a group when Telegram reports that the bot was removed', async () => {
  await harness.sendMyChatMember({ chatId, newStatus: 'left' });
  expect(await groups.findByTelegramChatId(chatId)).toMatchObject({ enabled: false });
});
```

The end-to-end test sends synthetic `my_chat_member`, `/start`, and wizard callback updates through the webhook and asserts the configured group row.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/application/src/groups/onboard-group.spec.ts packages/telegram/src/signed-start-token.spec.ts packages/telegram/src/group-onboarding.e2e.spec.ts`

Expected: FAIL because the use cases, signer, and handlers do not exist.

- [ ] **Step 3: Implement authorization, webhook validation, and resumable wizard**

The webhook controller must reject an invalid secret before passing JSON to grammY:

```ts
if (request.headers['x-telegram-bot-api-secret-token'] !== env.TELEGRAM_WEBHOOK_SECRET) {
  throw new UnauthorizedException();
}
await bot.handleUpdate(request.body as Update);
```

`OnboardGroup` must:

1. call `getChatMember` for the initiating user;
2. accept only `creator` or `administrator`;
3. upsert the group and user;
4. assign `OWNER` to a creator and `ADMIN` to an administrator;
5. create an audited onboarding state;
6. return a signed private-chat link.

`ConfigureGroup` validates `Intl.DateTimeFormat` support for the IANA zone and stores explicit defaults:

```ts
export interface ConfigureGroupCommand {
  groupId: GroupId;
  actorTelegramId: TelegramId;
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

`ChangeGroupRole` requires `OWNER` or `ADMIN`, accepts only `ORGANIZER` and `MEMBER` as target roles, verifies that the target currently belongs to the Telegram group, and writes an audit event. Handle `my_chat_member` removal by disabling the group and re-addition by reactivating the same record. Persist wizard progress so repeated `/start` resumes at the first incomplete field. Never store wizard state only in grammY session memory.

- [ ] **Step 4: Run focused and complete verification**

Run: `pnpm vitest run packages/application/src/groups/onboard-group.spec.ts packages/application/src/groups/change-group-role.spec.ts packages/telegram/src/signed-start-token.spec.ts packages/telegram/src/group-onboarding.e2e.spec.ts`

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`

Expected: focused tests and full suite pass; static checks and build exit 0.

- [ ] **Step 5: Commit onboarding**

```bash
git add apps/api packages/application packages/telegram packages/persistence packages/domain
git commit -m "feat: add secure group onboarding"
```

## Milestone Acceptance

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker compose config
```

The milestone is complete when an administrator can add the bot, follow a signed private configuration link, finish a resumable wizard, and produce an isolated configured group record through a validated Telegram webhook.
