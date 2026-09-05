import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  'continue-on-error'?: unknown;
  if?: unknown;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  'continue-on-error'?: unknown;
  if?: unknown;
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

const checkout = {
  name: 'Check out repository',
  uses: 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
};

const pnpmSetup = {
  name: 'Set up pnpm',
  uses: 'pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320',
  with: {
    run_install: false,
    version: '11.19.0',
  },
};

const nodeSetup = {
  name: 'Set up Node.js',
  uses: 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
  with: {
    cache: 'pnpm',
    'cache-dependency-path': 'pnpm-lock.yaml',
    'node-version': '24',
  },
};

const commandsFor = (job: WorkflowJob): string[] =>
  (job.steps ?? []).flatMap((step) =>
    step.run === undefined ? [] : [step.run],
  );

const expectRequiredJob = (job: WorkflowJob): void => {
  expect(job).not.toHaveProperty('if');
  expect(job).not.toHaveProperty('continue-on-error');
  expect(job.permissions).toBeUndefined();
  for (const step of job.steps ?? []) {
    expect(step).not.toHaveProperty('if');
    expect(step).not.toHaveProperty('continue-on-error');
  }
};

describe('GitHub Actions CI contract', () => {
  it('runs the exact read-only checks and never publishes or deploys', async () => {
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
    if (
      quality === undefined ||
      test === undefined ||
      containerBuild === undefined
    ) {
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
      expectRequiredJob(job);
    }

    expect(quality.steps).toEqual([
      checkout,
      pnpmSetup,
      nodeSetup,
      { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
      { name: 'Typecheck', run: 'pnpm typecheck' },
      { name: 'Lint', run: 'pnpm lint' },
      { name: 'Check formatting', run: 'pnpm format:check' },
      { name: 'Build TypeScript', run: 'pnpm build' },
    ]);
    expect(test.steps).toEqual([
      checkout,
      pnpmSetup,
      nodeSetup,
      { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
      { name: 'Run tests', run: 'pnpm test' },
    ]);
    expect(containerBuild.steps).toEqual([
      checkout,
      {
        name: 'Validate Compose configuration',
        run: 'docker compose --env-file .env.compose.example -f compose.yaml -f compose.dev.yaml config',
      },
      {
        name: 'Build production images',
        run: 'docker compose --env-file .env.compose.example -f compose.yaml build api worker',
      },
    ]);

    const commands = Object.values(jobs).flatMap(commandsFor);
    expect(commands).not.toEqual([]);
    for (const command of commands) {
      expect(command).not.toMatch(
        /\b(?:secrets?|auth(?:enticate|entication|orization)?|login)\b/i,
      );
      expect(command).not.toMatch(
        /\b(?:publish|release|upload(?:-artifact)?)\b/i,
      );
      expect(command).not.toMatch(/\bdocker\s+(?:login|push)\b/i);
      expect(command).not.toMatch(/\bdocker(?:\s+\S+)*\s+--push\b/i);
      expect(command).not.toMatch(/\bdeploy(?:ment)?\b/i);
      expect(command).not.toMatch(
        /\bdocker(?:\s+(?:compose|container))?\s+(?:up|start|run)\b/i,
      );
    }

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
  });
});
