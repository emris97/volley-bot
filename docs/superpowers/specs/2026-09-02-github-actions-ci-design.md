# GitHub Actions CI Design

**Date:** 2026-09-02
**Status:** Approved for implementation

## Context

The repository already has repeatable local checks and production Dockerfiles, but GitHub does not run them automatically. A pull request can therefore be merged even if TypeScript compilation, static analysis, tests, Compose validation, or a production image build is broken.

Deployment to Yandex Cloud is intentionally a separate concern. The application contains a continuously running BullMQ worker, PostgreSQL, and Redis, so the likely deployment target is a Compute Cloud virtual machine running Docker Compose rather than a request-driven Cloud Function or Serverless Container. This CI change prepares deployable images without choosing credentials, a registry, or a production host.

## Goal

Add one GitHub Actions workflow that gives every pull request and every update to `main` a reproducible, read-only verification gate for:

- dependency installation from the committed lockfile;
- TypeScript type checking and compilation;
- ESLint and Prettier checks;
- the complete Vitest suite, including Testcontainers integration tests;
- Docker Compose interpolation and schema validation;
- production builds of the API and worker images.

## Non-goals

This pull request will not:

- publish Docker images or other artifacts;
- authenticate to Yandex Cloud or any container registry;
- deploy, restart, migrate, or otherwise change an environment;
- introduce repository or environment secrets;
- alter GitHub branch-protection settings;
- run scheduled production checks;
- redesign the existing test suite, Dockerfiles, or Compose topology.

## Workflow interface

The workflow lives at `.github/workflows/ci.yml` and is named `CI`.

It runs for:

- `pull_request`, so proposed changes are checked before merge;
- pushes to `main`, so the integrated state is checked independently of pull-request history.

It does not use `pull_request_target`, because pull-request code must never execute in a privileged context. Workflow-level permissions are restricted to `contents: read`. No job receives write permissions or repository secrets.

Concurrency is grouped by workflow and Git ref. When a newer commit arrives for the same pull request or branch, GitHub cancels the superseded run. Runs for different pull requests remain independent.

All jobs use `ubuntu-latest`, Node.js 24, and pnpm 11.19.0, matching `package.json`. Dependencies are installed with `pnpm install --frozen-lockfile`. pnpm's content-addressable store is cached through `actions/setup-node`; the cache key is derived from `pnpm-lock.yaml`, while `node_modules` is never cached.

Every third-party action is referenced by an immutable 40-character commit SHA. A nearby comment records the corresponding release tag to keep upgrades understandable and deliberate.

## Job structure

### `quality`

This job installs dependencies once and runs, in order:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm format:check`
4. `pnpm build`

The order surfaces inexpensive source-level failures before compilation. Any non-zero command terminates the job. The job timeout is 20 minutes.

### `test`

This job installs dependencies and runs `pnpm test` with a 25-minute timeout.

The test suite remains unchanged. GitHub-hosted Ubuntu runners provide Docker, and Testcontainers creates the PostgreSQL and Redis instances required by integration tests. The workflow does not define duplicate database service containers and does not skip integration tests.

### `container-build`

This job starts only after `quality` and `test` succeed, avoiding Docker build minutes for a revision that is already invalid. It has a 25-minute timeout and performs two checks:

1. `docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config`
2. `docker compose --env-file .env.compose.example -f compose.yaml build api worker`

The checked-in example environment is used only to resolve required Compose variables. Containers are not started, migrations are not executed, and the example credentials never leave the runner.

Building through Compose validates the same build contexts, Dockerfiles, image relationships, and configuration that the deployment path will use. Images remain in the ephemeral runner cache and are discarded when the job ends.

## Failure and cancellation behavior

A failed command makes its job fail and prevents `container-build` from running when either prerequisite failed. GitHub displays the three job results independently, making it clear whether the issue is source quality, application behavior, or packaging.

Superseded runs are cancelled through workflow concurrency. Explicit timeouts prevent a stuck package download, Testcontainers startup, or image build from consuming a runner indefinitely.

## Security and supply-chain boundaries

- The workflow has read-only repository access.
- Pull-request code runs only under the normal `pull_request` event.
- No secrets are referenced, forwarded to subprocesses, or added to example files.
- Dependency versions remain governed by the committed pnpm lockfile.
- External actions are SHA-pinned.
- Docker images are built but never logged in, tagged for a remote registry, or pushed.
- The workflow does not execute Compose services, so example database and Telegram values cannot contact external systems.

## Verification strategy

Implementation is accepted when all of the following hold:

- the new workflow parses as valid YAML;
- a repository contract test confirms the intended triggers, read-only permissions, pinned actions, required commands, and absence of publishing/deployment behavior;
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, and `pnpm test` pass locally;
- Compose configuration resolves using `.env.compose.example`;
- both production images build successfully;
- the branch's GitHub Actions run completes with `quality`, `test`, and `container-build` green.

The contract test protects the workflow's security and coverage characteristics from accidental weakening without attempting to emulate the GitHub Actions runtime.

## Follow-up deployment direction

A later, separate pull request may add continuous deployment to one Yandex Compute Cloud virtual machine running Docker Compose, with HTTPS termination and persistent PostgreSQL storage. That change should publish versioned images to Yandex Container Registry and use GitHub OpenID Connect workload identity federation instead of a long-lived service-account key. None of those credentials or deployment mutations belong in this CI pull request.
