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
