# GitHub Actions CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only GitHub Actions workflow that verifies source quality, the complete test suite, Compose configuration, and production API and worker image builds.

**Architecture:** One workflow runs independent `quality` and `test` jobs on pull requests and pushes to `main`; a dependent `container-build` job runs only after both succeed. A Vitest contract test parses the workflow as YAML and locks down its triggers, permissions, runtime versions, required commands, action pinning, and non-deployment boundary.

**Tech Stack:** GitHub Actions, Node.js 24, pnpm 11.19.0, Vitest 4, YAML 2.9.0, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-02-github-actions-ci-design.md`

## Global Constraints

- The workflow file is `.github/workflows/ci.yml` and its display name is `CI`.
- Run on `pull_request` and pushes to `main`; never use `pull_request_target`.
- Set workflow permissions to exactly `contents: read`; do not grant job-level permissions.
- Use `ubuntu-latest`, Node.js 24, and pnpm 11.19.0.
- Install dependencies with `pnpm install --frozen-lockfile` and cache only pnpm's store through `actions/setup-node` using `pnpm-lock.yaml`.
- Pin every third-party action to an immutable 40-character commit SHA and annotate it with its release version.
- Run all existing typecheck, lint, formatting, build, and test commands without weakening or skipping integration tests.
- Validate Compose with `.env.compose.example` and build the `api` and `worker` services without starting containers.
- Do not reference secrets, authenticate, publish artifacts or images, or deploy anything.
- Give `quality` a 20-minute timeout and `test` and `container-build` 25-minute timeouts.

---

### Task 1: Lock the workflow contract with a failing test

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `tests/release/github-actions-ci.spec.ts`

**Interfaces:**

- Consumes: the repository root as the Vitest working directory and YAML 1.2 workflow syntax.
- Produces: a contract test that expects `.github/workflows/ci.yml` to expose the exact triggers, permissions, jobs, runtimes, commands, and security boundary from the approved design.

- [ ] **Step 1: Add the YAML parser as a direct development dependency**

Run:

```bash
pnpm add --save-dev --save-exact yaml@2.9.0
```

Expected: `package.json` contains `"yaml": "2.9.0"` in `devDependencies`, and `pnpm-lock.yaml` records it as a root development dependency without changing unrelated versions.

- [ ] **Step 2: Write the workflow contract test**

Create `tests/release/github-actions-ci.spec.ts` with:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string[];
  permissions?: Record<string, string>;
  'runs-on'?: string;
  steps?: WorkflowStep[];
  'timeout-minutes'?: number;
}

interface WorkflowDocument {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
  };
  jobs?: Record<string, WorkflowJob>;
  name?: string;
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
  };
  permissions?: Record<string, string>;
}

const commandsFor = (job: WorkflowJob): string =>
  (job.steps ?? [])
    .flatMap((step) => (step.run === undefined ? [] : [step.run]))
    .join('\n');

const setupFor = (
  job: WorkflowJob,
  action: 'actions/setup-node' | 'pnpm/action-setup',
): WorkflowStep | undefined =>
  (job.steps ?? []).find((step) => step.uses?.startsWith(`${action}@`));

describe('GitHub Actions CI contract', () => {
  it('runs the required read-only checks and never publishes or deploys', async () => {
    const workflowText = await readFile('.github/workflows/ci.yml', 'utf8');
    const workflow = parse(workflowText) as WorkflowDocument;

    expect(workflow.name).toBe('CI');
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on?.push).toEqual({ branches: ['main'] });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(true);
    expect(workflow.concurrency?.group).toBe(
      'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );

    const jobs = workflow.jobs ?? {};
    expect(Object.keys(jobs).sort()).toEqual(
      ['container-build', 'quality', 'test'].sort(),
    );

    const quality = jobs.quality;
    const test = jobs.test;
    const containerBuild = jobs['container-build'];
    expect(quality).toBeDefined();
    expect(test).toBeDefined();
    expect(containerBuild).toBeDefined();
    if (quality === undefined || test === undefined || containerBuild === undefined) {
      throw new Error('required CI jobs are missing');
    }

    expect(quality['runs-on']).toBe('ubuntu-latest');
    expect(test['runs-on']).toBe('ubuntu-latest');
    expect(containerBuild['runs-on']).toBe('ubuntu-latest');
    expect(quality['timeout-minutes']).toBe(20);
    expect(test['timeout-minutes']).toBe(25);
    expect(containerBuild['timeout-minutes']).toBe(25);
    expect(containerBuild.needs).toEqual(['quality', 'test']);

    for (const job of [quality, test, containerBuild]) {
      expect(job.permissions).toBeUndefined();
    }

    for (const job of [quality, test]) {
      expect(setupFor(job, 'pnpm/action-setup')?.with).toMatchObject({
        run_install: false,
        version: '11.19.0',
      });
      expect(setupFor(job, 'actions/setup-node')?.with).toMatchObject({
        cache: 'pnpm',
        'cache-dependency-path': 'pnpm-lock.yaml',
        'node-version': '24',
      });
      expect(commandsFor(job)).toContain('pnpm install --frozen-lockfile');
    }

    const qualityCommands = commandsFor(quality);
    expect(qualityCommands).toContain('pnpm typecheck');
    expect(qualityCommands).toContain('pnpm lint');
    expect(qualityCommands).toContain('pnpm format:check');
    expect(qualityCommands).toContain('pnpm build');
    expect(commandsFor(test)).toContain('pnpm test');

    const containerCommands = commandsFor(containerBuild);
    expect(containerCommands).toContain(
      'docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config',
    );
    expect(containerCommands).toContain(
      'docker compose --env-file .env.compose.example -f compose.yaml build api worker',
    );

    const referencedActions = Object.values(jobs).flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        step.uses === undefined ? [] : [step.uses],
      ),
    );
    expect(referencedActions.length).toBeGreaterThan(0);
    const allowedActions = [
      'actions/checkout',
      'actions/setup-node',
      'pnpm/action-setup',
    ];
    for (const action of referencedActions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(allowedActions).toContain(action.split('@')[0]);
    }
    const usesLines = workflowText
      .split('\n')
      .filter((line) => line.trimStart().startsWith('uses:'));
    for (const line of usesLines) {
      expect(line).toMatch(/@[0-9a-f]{40} # v\d+(?:\.\d+){2}$/);
    }

    expect(workflowText).not.toContain('pull_request_target');
    expect(workflowText).not.toMatch(/\bsecrets\./);
    expect(containerCommands).not.toMatch(/docker (?:login|push)/);
    expect(containerCommands).not.toMatch(/\bdeploy\b/i);
  });
});
```

- [ ] **Step 3: Run the contract test and verify the expected failure**

Run:

```bash
pnpm vitest run tests/release/github-actions-ci.spec.ts
```

Expected: FAIL with `ENOENT` for `.github/workflows/ci.yml`. A parser, assertion, import, or TypeScript failure is not the expected red state and must be corrected before continuing.

- [ ] **Step 4: Commit the red contract**

```bash
git add package.json pnpm-lock.yaml tests/release/github-actions-ci.spec.ts
git commit -m "test: define GitHub Actions CI contract"
```

---

### Task 2: Implement and verify the CI workflow

**Files:**

- Create: `.github/workflows/ci.yml`
- Test: `tests/release/github-actions-ci.spec.ts`

**Interfaces:**

- Consumes: the contract established in Task 1, root pnpm scripts, `.env.compose.example`, `compose.yaml`, `compose.dev.yaml`, `apps/api/Dockerfile`, and `apps/worker/Dockerfile`.
- Produces: the `CI` GitHub workflow with `quality`, `test`, and `container-build` status checks and no external side effects.

- [ ] **Step 1: Create the minimal workflow that satisfies the contract**

Create `.github/workflows/ci.yml` with:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out repository
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0

      - name: Set up pnpm
        uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0
        with:
          version: '11.19.0'
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: '24'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Typecheck
        run: pnpm typecheck

      - name: Lint
        run: pnpm lint

      - name: Check formatting
        run: pnpm format:check

      - name: Build TypeScript
        run: pnpm build

  test:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: Check out repository
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0

      - name: Set up pnpm
        uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0
        with:
          version: '11.19.0'
          run_install: false

      - name: Set up Node.js
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: '24'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm test

  container-build:
    needs:
      - quality
      - test
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - name: Check out repository
        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0

      - name: Validate Compose configuration
        run: docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config

      - name: Build production images
        run: docker compose --env-file .env.compose.example -f compose.yaml build api worker
```

- [ ] **Step 2: Run the focused contract test and verify it passes**

Run:

```bash
pnpm vitest run tests/release/github-actions-ci.spec.ts
```

Expected: PASS with one test file and one passing test.

- [ ] **Step 3: Run source-level verification**

Run each command independently so the failing gate is unambiguous:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
```

Expected: all four commands exit with status 0. If formatting alone fails, run `pnpm exec prettier --write .github/workflows/ci.yml tests/release/github-actions-ci.spec.ts docs/superpowers/plans/2026-09-02-github-actions-ci.md`, inspect the diff, and rerun all four commands.

- [ ] **Step 4: Validate Compose interpolation and schema**

Run:

```bash
docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config
```

Expected: exit status 0 and rendered services for `postgres`, `redis`, `db-migrate`, `api`, and `worker`, with no missing-variable error.

- [ ] **Step 5: Build both production application images**

Run:

```bash
docker compose --env-file .env.compose.example -f compose.yaml build api worker
```

Expected: exit status 0 with local images `volley-bot-api` and `volley-bot-worker`; no registry login or push occurs.

- [ ] **Step 6: Run the complete test suite**

Run:

```bash
pnpm test
```

Expected: all test files and tests pass, including Testcontainers-backed PostgreSQL and Redis integration tests.

- [ ] **Step 7: Inspect the final change boundary**

Run:

```bash
git diff --check
git status --short
git diff --stat main...HEAD
```

Expected: no whitespace errors; only the workflow, its contract test, the direct YAML development dependency and lockfile entry, and the approved design/implementation documents are present.

- [ ] **Step 8: Commit the green workflow**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: verify code and container builds"
```

- [ ] **Step 9: Re-run the focused and full verification from committed state**

Run:

```bash
pnpm vitest run tests/release/github-actions-ci.spec.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test
docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config
docker compose --env-file .env.compose.example -f compose.yaml build api worker
git status --short
```

Expected: every command exits with status 0 and the working tree is clean.
