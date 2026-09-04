# Russian Group Onboarding and Production CD — Design Specification

Date: 2026-09-05
Status: approved design

## 1. Purpose

Replace the current placeholder onboarding messages such as `onboarding:tz` with a complete Russian seven-step configuration wizard, prevent expected user mistakes from returning HTTP 500 to Telegram, and add automatic production deployment from GitHub after a successful change reaches the repository's `main` branch.

This specification refines the onboarding requirements in `2026-08-31-volleyball-bot-design.md`. It does not introduce game creation, arbitrary localization, additional time zones, or a container registry.

## 2. Scope

The change has three deliverables:

1. A Russian, button-driven, resumable group onboarding wizard.
2. Explicit separation between expected Telegram input errors and retryable infrastructure failures.
3. A GitHub Actions CI/CD workflow that deploys an exact tested commit to the existing VDS.

The following remain out of scope:

- languages other than Russian;
- time zones other than `Europe/Astrakhan`;
- changing already configured group settings;
- GitHub Container Registry or another image registry;
- a self-hosted GitHub Actions runner;
- replacing the existing Caddy, Docker Compose, certificate renewal, or production secret setup;
- a database schema migration.

## 3. Onboarding User Experience

### 3.1 Entry from the group

When the bot is added or re-added to a Telegram group, it verifies that the actor is the group owner or an administrator. For an unconfigured or partially configured group, it posts a fresh private-chat configuration link valid for 15 minutes.

Re-adding the bot must reactivate the existing group and preserve `onboarding_data`. It must not create a duplicate group or clear completed wizard answers. A fresh link resumes at the first unanswered step.

If the group is already configured, re-adding the bot only reactivates it. It must not reset settings or restart onboarding.

### 3.2 One-message wizard

The private wizard uses one Telegram message. The first step sends it; each valid callback edits that same message. A repeated `/start` may send a new current-state message, after which its callbacks continue by editing that message.

Every step shows:

- a Russian title and short explanation;
- the current step number, for example `Шаг 3 из 7`;
- an inline keyboard containing only valid choices.

The seven steps and stored values are:

1. **Time zone (`tz`)**
   - `Астрахань (UTC+4)` → `Europe/Astrakhan`.
2. **Registration priority (`mp`)**
   - `Участники группы выше гостей` → `true`;
   - `В порядке записи` → `false`.
3. **Tentative confirmation prompt (`tp`)**
   - `За 24 часа` → `1440` minutes;
   - `За 12 часов` → `720` minutes;
   - `За 6 часов` → `360` minutes.
4. **Tentative response window (`tr`)**
   - `30 минут` → `30` minutes;
   - `1 час` → `60` minutes;
   - `2 часа` → `120` minutes.
5. **Game reminder (`rm`)**
   - `За 30 минут` → `30` minutes;
   - `За 1 час` → `60` minutes;
   - `За 2 часа` → `120` minutes.
6. **Payment rounding (`ro`)**
   - `Точно до копеек` → `EXACT`;
   - `Вверх до 1 ₽` → `UP_1`;
   - `Вверх до 10 ₽` → `UP_10`;
   - `Вверх до 50 ₽` → `UP_50`.
7. **Pin game messages (`pin`)**
   - `Да` → `true`;
   - `Нет` → `false`.

The first choice shown on steps 3, 4, and 5 corresponds to the existing defaults: 24 hours, 1 hour, and 2 hours. Choices are not silently selected; the administrator must press a button on every step.

### 3.3 Summary and confirmation

After step 7, the same message becomes a Russian summary of all seven answers. It provides two actions:

- `✅ Сохранить настройки`;
- `🔄 Начать заново`.

Wizard answers remain only in `onboarding_data` until the administrator presses save. Save calls the existing `ConfigureGroup` application service, changes the onboarding state to `CONFIGURED`, stores the settings, and clears `onboarding_data` through the existing repository operation.

Reset explicitly replaces `onboarding_data` with an empty object and renders step 1. It does not disable the group or create a new onboarding session.

If `/start` is repeated while configuration is incomplete, the bot renders the first incomplete step. If a valid old configuration link is opened after the group has already been configured, the bot renders the current saved-settings summary without changing data and without showing the onboarding save action.

## 4. Telegram Adapter Design

### 4.1 Presenter boundary

Add a pure presenter next to the existing handler, following the package's current flat source layout:

- `packages/telegram/src/group-onboarding.presenter.ts`;
- `packages/telegram/src/group-onboarding.presenter.spec.ts`.

The presenter owns Russian copy, option labels, summary formatting, and inline-keyboard construction. It receives typed wizard state and returns a view containing message text, optional HTML parse mode, and keyboard rows. It performs no I/O and does not read repositories.

`GroupOnboardingHandlers` continues to own authorization, state transitions, progress persistence, and the final call to `ConfigureGroup`. This keeps business flow separate from presentation without introducing a general i18n framework.

### 4.2 Callback protocol

Existing field callbacks retain the compact format:

```text
cfg:<groupUuid>:<field>:<value>
```

Summary actions use dedicated action codes under the same `cfg:` namespace, for example:

```text
cfg:<groupUuid>:save:1
cfg:<groupUuid>:reset:1
```

All generated callback payloads must remain within Telegram's 64-byte limit. Callback parsing validates the prefix, UUID, action, value, and allowed value for the current field before changing state.

The callback input passed from `bot.factory.ts` to the handler gains the callback message ID. The handler uses `TelegramGateway.editMessage` to advance, summarize, recover from stale callbacks, and reset. If the callback has no editable message, it may send a replacement current-state message instead of failing the update.

Every callback query is acknowledged with `answerCallbackQuery`, including valid, stale, rejected, and failed actions. User-correctable failures may use the callback alert text; infrastructure failures are acknowledged before the error is rethrown when possible.

### 4.3 State reads

Extend the onboarding repository boundary with a focused onboarding snapshot read that exposes:

- group onboarding state;
- current `onboarding_data`;
- saved group settings required for the configured summary.

This avoids inferring `CONFIGURED` from an empty progress object. Existing `onboarding_data` storage is sufficient and no schema migration is required.

`beginOnboarding` already changes only the onboarding state and preserves progress. The re-add flow should reuse `OnboardGroup` for unconfigured groups so it verifies current Telegram administrator status, refreshes membership, and creates a fresh signed link. It must not call `beginOnboarding` for a group whose state is already `CONFIGURED`.

## 5. Error Semantics and HTTP Status

Telegram treats a non-2xx webhook response as a failed update and retries it. Therefore, expected input and authorization outcomes must be handled inside the Telegram adapter and complete normally so the webhook returns HTTP 200.

### 5.1 Expected outcomes that return HTTP 200

- Bare `/start`: explain in Russian that configuration must be opened from the link posted in the group.
- Malformed or invalid start token: show a safe invalid-link message.
- Expired start token: ask the administrator to obtain a new link by re-adding the bot to the group.
- Configuration link issued to another administrator: refuse safely without revealing group details.
- Unsupported start purpose when no matching private flow exists: show a safe instruction instead of throwing.
- Invalid, stale, or repeated onboarding callback: acknowledge it and render the authoritative current step or summary.
- Callback belonging to another administrator or a user who is no longer an administrator: acknowledge and show a safe refusal.
- Start link for an already configured group: display the saved summary without mutation.

These outcomes may be logged at `info` or `warn`, but they are not server failures.

### 5.2 Failures that return HTTP 500

Unknown or infrastructure failures are rethrown so Telegram can retry the update. This includes unavailable PostgreSQL or Redis dependencies, network failures, Telegram Bot API failures that prevent the required response, and unexpected programming errors.

The implementation must not broadly catch every `Error` and convert it to HTTP 200. It introduces typed, narrow error reasons for signed-start verification and onboarding input/authorization outcomes. Only known expected types are mapped to user-facing responses; everything else propagates.

Signed-start verification distinguishes at least:

- invalid signature or encoding;
- expired token.

The external messages remain generic and must not reveal whether a group ID, user ID, or signature fragment was valid.

### 5.3 Logging

Structured logs for onboarding failures include the Telegram `updateId`, a stable error category, and the request correlation ID already used by the API. Where useful they may include the internal group ID after successful token verification.

Logs must not contain:

- bot tokens or webhook secrets;
- signed `/start` parameters or full links;
- raw private messages;
- personal names or Telegram identifiers when not operationally required.

## 6. Test Strategy

### 6.1 Presenter unit tests

Verify exact Russian text, step numbers, labels, stored callback values, summary formatting, row layout, and the 64-byte callback limit for all seven steps plus save/reset actions.

### 6.2 Token and handler tests

Extend signed-token tests to assert typed invalid and expired outcomes without changing the fixed compact token format.

Update onboarding handler tests to cover:

- all seven steps in order;
- message editing instead of seven new messages;
- persistence after each valid answer;
- no `ConfigureGroup` call before save;
- correct `ConfigureGroup` command after save;
- reset clearing progress and returning to step 1;
- resume at the first unanswered step;
- a stale/repeated callback rendering current state without mutation;
- a valid old link for an already configured group returning the saved summary;
- re-adding an unfinished group creating a new 15-minute link while preserving progress;
- re-adding a configured group without resetting it;
- callback acknowledgement on every branch.

### 6.3 Webhook regression tests

At the grammY/API boundary, prove that:

- bare `/start`, invalid links, expired links, foreign links, and stale callbacks complete with HTTP 200;
- a deliberately injected infrastructure failure returns HTTP 500;
- an invalid or bare `/start` followed by a valid `/start` does not block the valid update;
- valid guest start links continue to reach the guest flow rather than being consumed by onboarding error handling.

Update `packages/telegram/src/group-onboarding.e2e.spec.ts` and `tests/e2e/mvp-acceptance.e2e.spec.ts` so they no longer assert placeholder `onboarding:*` messages.

### 6.4 Repository-wide verification

The implementation is complete only after these commands pass from the repository root:

```text
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

## 7. GitHub Actions CI/CD

### 7.1 Trigger and gates

Add `.github/workflows/ci-cd.yml` with two logical jobs:

1. `quality` runs for pull requests and pushes to `main` and executes dependency installation with the frozen lockfile, tests, type checking, linting, formatting checks, and build.
2. `deploy-production` runs only for a push to `main`, requires `quality`, and targets the GitHub Environment named `production`.

The repository uses `main`, not `master`; branch protection should require the `quality` check before merge. Direct pushes to `main` should be disabled in repository settings so every automatic deployment corresponds to reviewed code.

Production deployments use a single `concurrency` group and do not cancel a deployment already in progress. A newer commit waits or is deployed in the next serialized run, preventing two Docker Compose updates from racing.

The workflow also supports `workflow_dispatch` for an intentional redeploy of the current `main` commit. It does not accept an arbitrary shell command or arbitrary Git ref as input.

### 7.2 Deployment transport

Use a GitHub-hosted Ubuntu runner and native OpenSSH to call the VDS. Do not install a self-hosted Actions runner on the production server.

The GitHub `production` environment holds only deployment transport data:

- `PRODUCTION_HOST` (`npoletaev97.fvds.ru`);
- `PRODUCTION_USER` (a dedicated non-root deployment account);
- `PRODUCTION_SSH_KEY` (a dedicated private key used only by Actions);
- `PRODUCTION_HOST_KEY` (the pinned `known_hosts` entry).

The workflow passes the tested 40-character commit SHA. It never sends the Telegram token, database password, Redis password, webhook secret, Caddy private key, or the contents of `/etc/volley-bot/production.env` through GitHub.

Third-party actions are minimized. Required official actions such as checkout and Node setup are pinned to full commit SHAs rather than mutable tags, and workflow token permissions are explicitly read-only unless a narrower job requires more.

### 7.3 VDS authorization boundary

Create a dedicated deployment account with:

- password login disabled;
- no reusable root key;
- no access to production environment secrets;
- an SSH key restricted with `no-agent-forwarding`, `no-port-forwarding`, `no-X11-forwarding`, and `no-pty`;
- permission to invoke only a root-owned deployment wrapper.

The root-owned wrapper is stored outside the Git checkout, validates that the requested revision is exactly 40 hexadecimal characters, serializes execution with a lock, and rejects unexpected SSH commands. The checked-out repository must not be able to modify this wrapper or the SSH authorization policy.

Deployment access necessarily allows tested `main` code to become production code. Repository write access, workflow edits, branch protection, and production environment access must therefore be treated as production privileges.

### 7.4 Server deployment procedure

For commit `<sha>`, the wrapper:

1. acquires the production deployment lock;
2. fetches `origin/main` in `/opt/volley-bot`;
3. verifies that `<sha>` is reachable from `origin/main` and that the tracked production checkout has no local modifications;
4. records the currently deployed revision as the previous known revision;
5. checks out the exact `<sha>` without deleting untracked deployment-owned files;
6. builds the API and worker images using the existing production Compose override;
7. runs the existing one-shot database migration service;
8. recreates the API and worker while leaving PostgreSQL, Redis, Caddy, volumes, and certificates intact;
9. waits for Docker health checks and verifies the public readiness endpoint;
10. writes the successfully deployed SHA to a root-owned deployment-state file and exits successfully.

The deployment must not modify or commit these server-owned assets:

- `/etc/volley-bot/production.env`;
- `/opt/volley-bot/compose.prod.yaml`;
- `/opt/volley-bot/Caddyfile`;
- ISPmanager certificate files and the Caddy certificate-reload timer.

If build or migration fails before containers are replaced, the existing running containers stay in service and the job fails. If readiness fails after replacement, the wrapper reports failure and retains the previous SHA for an operator-triggered rollback. Database migrations must follow a backward-compatible expand/contract policy because an automatic application rollback cannot safely reverse an arbitrary schema migration.

### 7.5 Deployment observability and rollback

The Actions job shows the deployed SHA, stage names, container health, and readiness result without printing secret values or the environment file. Full application logs are not streamed automatically because they may contain operational data; the failure output provides the server-side `docker compose logs` command for investigation.

Rollback is an explicit, auditable operation that redeploys the recorded previous known-good SHA through the same root-owned wrapper. The first CD version does not build or publish immutable registry images, so rollback rebuilds that earlier source revision on the VDS. Moving image builds to GHCR with SHA tags is a future optimization.

## 8. Deployment Acceptance Check

After the feature is merged and the workflow deploys it:

1. GitHub shows a passing `quality` job followed by one successful `production` deployment for the merged SHA.
2. The VDS checkout and deployment-state file report that same SHA.
3. PostgreSQL, Redis, Caddy, API, and worker remain healthy.
4. Telegram webhook information shows no growing pending-update queue.
5. A fresh or resumed Astrakhan onboarding completes all seven steps, displays the summary, saves only after confirmation, and shows the configured result.
6. Bare `/start` returns the Russian instruction and does not prevent a subsequent valid link from advancing the wizard.
7. No secret value or signed start parameter appears in GitHub Actions output or application logs.

## 9. Implementation Boundaries

The implementation should be delivered in small, independently testable commits: presenter, wizard state/confirmation, error mapping, regression tests, CI workflow, and VDS bootstrap documentation. Application behavior and CD configuration may share one implementation plan, but the VDS bootstrap is performed once and kept separate from recurring deploy runs.

No unrelated refactor, database migration, generalized localization framework, container registry, or provider-specific orchestration is part of this change.
