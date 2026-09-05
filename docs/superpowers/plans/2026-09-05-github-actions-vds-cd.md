# GitHub Actions to VDS Continuous Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically deploy the exact tested `main` commit to the existing VDS after merge, using a GitHub-hosted runner, restricted SSH credentials, serialized Docker Compose deployment, readiness verification, and an explicit rollback path.

**Architecture:** Extend the existing `.github/workflows/ci.yml` so its `quality`, `test`, and `container-build` jobs remain the single verification pipeline and a dependent production job connects over SSH as a dedicated non-root account. A forced-command dispatcher passes one validated command to a root-owned deployment wrapper outside the checkout; the wrapper fetches an exact commit reachable from `origin/main`, builds on the VDS, runs migrations, recreates only API and worker, and records deployed revisions.

**Tech Stack:** GitHub Actions, Ubuntu 24.04 GitHub-hosted runners, OpenSSH, Bash, Git, Docker Engine with Compose v2, Node.js 24, pnpm 11.19.0, systemd-compatible Ubuntu VDS

**Spec:** `docs/superpowers/specs/2026-09-05-onboarding-and-cd-design.md`

## Global Constraints

- Deploy from repository branch `main`; do not create or reference `master`.
- Preserve the existing `.github/workflows/ci.yml` jobs and contract test; do not create a parallel CI/CD workflow.
- A production deploy may run only after the existing `quality`, `test`, and `container-build` jobs pass for the same commit.
- Use GitHub-hosted runners; do not install a self-hosted runner on the VDS.
- Use a dedicated deployment account and SSH key; never deploy using the existing personal root key.
- Keep `BOT_TOKEN`, database/Redis passwords, webhook secret, Caddy key, and `/etc/volley-bot/production.env` off GitHub.
- Preserve `/opt/volley-bot/compose.prod.yaml`, `/opt/volley-bot/Caddyfile`, database volumes, certificates, and the certificate reload timer.
- Serialize production deploys and never cancel one already in progress.
- The server wrapper must accept only `deploy <40-hex-sha>` over Actions SSH.
- Database migrations must be backward-compatible; there is no automatic schema downgrade.
- Keep every existing GitHub Action pinned to a full commit SHA; the deployment job uses native OpenSSH and adds no third-party action.
- Stage and commit only files named by the current task; never add `.pnpm-store/`.

---

### Task 1: Add executable deployment templates with safety regression tests

**Files:**
- Create: `deploy/production/volley-deploy-dispatch`
- Create: `deploy/production/deploy-volley-bot`
- Create: `tests/release/production-deploy.spec.ts`

**Interfaces:**
- Produces: non-root dispatcher installed as `/usr/local/bin/volley-deploy-dispatch`.
- Produces: root wrapper installed as `/usr/local/sbin/deploy-volley-bot`.
- SSH protocol: one line exactly matching `deploy [0-9a-f]{40}`.
- Local operator protocol: `/usr/local/sbin/deploy-volley-bot rollback <sha>`.

- [ ] **Step 1: Write failing static safety tests**

```ts
// tests/release/production-deploy.spec.ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFile(new URL(`../../deploy/production/${name}`, import.meta.url), 'utf8');

describe('production deployment scripts', () => {
  it('restricts the SSH dispatcher to one root wrapper invocation', async () => {
    const script = await read('volley-deploy-dispatch');
    expect(script).toContain('SSH_ORIGINAL_COMMAND');
    expect(script).toContain('sudo -n /usr/local/sbin/deploy-volley-bot --stdin');
    expect(script).not.toMatch(/eval|bash\s+-c|sh\s+-c/);
  });

  it('validates revisions, locks deployments, and preserves server-owned files', async () => {
    const script = await read('deploy-volley-bot');
    expect(script).toContain('^[0-9a-f]{40}$');
    expect(script).toContain('flock');
    expect(script).toContain('git merge-base --is-ancestor');
    expect(script).toContain('--untracked-files=no');
    expect(script).toContain('--wait');
    expect(script).toContain('--wait-timeout');
    expect(script).toContain('/etc/volley-bot/production.env');
    expect(script).toContain('compose.prod.yaml');
    expect(script).not.toMatch(/rm\s+-rf|git\s+clean|production\.env.*(?:cat|echo)/);
  });
});
```

- [ ] **Step 2: Run the safety test and confirm failure**

Run: `pnpm vitest run tests/release/production-deploy.spec.ts`

Expected: FAIL because both deployment scripts are absent.

- [ ] **Step 3: Implement the forced-command dispatcher**

```sh
#!/bin/sh
set -eu

printf '%s\n' "${SSH_ORIGINAL_COMMAND:-}" |
  sudo -n /usr/local/sbin/deploy-volley-bot --stdin
```

The dispatcher must contain no other command path and must not interpret the original command with `eval`, `sh -c`, or `bash -c`.

- [ ] **Step 4: Implement the root-owned deployment wrapper template**

Use the following structure and constants:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPOSITORY=/opt/volley-bot
readonly ENV_FILE=/etc/volley-bot/production.env
readonly STATE_DIR=/var/lib/volley-bot-deploy
readonly LOCK_FILE=/run/lock/volley-bot-deploy.lock

if [[ ${1:-} == --stdin ]]; then
  IFS=' ' read -r action revision extra
  [[ -z ${extra:-} ]] || { echo 'invalid deploy command' >&2; exit 64; }
elif [[ $# -eq 2 ]]; then
  action=$1
  revision=$2
else
  echo 'usage: deploy-volley-bot deploy|rollback <sha>' >&2
  exit 64
fi

[[ $action == deploy || $action == rollback ]] || exit 64
[[ $revision =~ ^[0-9a-f]{40}$ ]] || exit 64
if [[ ${1:-} == --stdin && $action != deploy ]]; then exit 64; fi

install -d -m 0750 "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'production deployment already running' >&2; exit 75; }

cd "$REPOSITORY"
[[ -z $(git status --porcelain --untracked-files=no) ]] || {
  echo 'tracked production checkout is dirty' >&2
  exit 65
}

git fetch --prune origin main
git cat-file -e "${revision}^{commit}"
git merge-base --is-ancestor "$revision" origin/main

checkout_before=$(git rev-parse HEAD)
if [[ -f $STATE_DIR/current ]]; then
  deployed=$(<"$STATE_DIR/current")
  [[ $deployed =~ ^[0-9a-f]{40}$ ]] || {
    echo 'invalid current deployment state' >&2
    exit 65
  }
  git cat-file -e "${deployed}^{commit}"
else
  deployed=$checkout_before
fi

write_state() {
  local name=$1
  local value=$2
  local temporary="$STATE_DIR/$name.tmp"
  printf '%s\n' "$value" >"$temporary"
  mv -f "$temporary" "$STATE_DIR/$name"
}

if [[ $revision != "$deployed" ]]; then
  write_state previous "$deployed"
fi
git checkout --detach "$revision"

compose=(docker compose --env-file "$ENV_FILE" -f compose.yaml -f compose.prod.yaml)

if ! "${compose[@]}" build api worker db-migrate; then
  git checkout --detach "$deployed"
  exit 1
fi
if ! "${compose[@]}" run --rm db-migrate; then
  git checkout --detach "$deployed"
  exit 1
fi
"${compose[@]}" up -d --no-deps --force-recreate --wait --wait-timeout 120 api worker

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
curl --fail --silent --show-error --retry 24 --retry-delay 5 \
  "${PUBLIC_BASE_URL%/}/health/ready" >/dev/null

"${compose[@]}" ps api worker
write_state current "$revision"
echo "deployed revision $revision"
```

Set the template files executable in Git:

Run: `git update-index --chmod=+x deploy/production/volley-deploy-dispatch deploy/production/deploy-volley-bot`

The root wrapper may be invoked locally with `rollback <sha>`, but rollback follows the same fetch/build/migrate/health path. It must not run `git clean`, delete untracked files, recreate PostgreSQL/Redis/Caddy, print the environment, or echo secrets. A build or migration failure restores the last recorded deployed checkout and leaves existing containers running. `docker compose up --wait` must fail if either API or worker does not become healthy; the public readiness probe is an additional external check. A post-replacement health or readiness failure exits nonzero and leaves `previous` pointing to the last known-good SHA for explicit operator rollback. Redeploying the current SHA must not overwrite `previous`.

- [ ] **Step 5: Run script syntax and safety checks**

Run on Linux or through the existing Docker runtime:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo bash:5.2 bash -n deploy/production/deploy-volley-bot
docker run --rm -v "$PWD:/repo:ro" -w /repo alpine:3.22 sh -n deploy/production/volley-deploy-dispatch
pnpm vitest run tests/release/production-deploy.spec.ts
```

Expected: both syntax checks exit 0 and the safety suite passes.

- [ ] **Step 6: Commit deployment templates**

```bash
git add deploy/production/volley-deploy-dispatch deploy/production/deploy-volley-bot tests/release/production-deploy.spec.ts
git commit -m "ops: add restricted production deploy wrapper"
```

---

### Task 2: Extend the existing SHA-pinned CI workflow with production deployment

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/release/github-actions-ci.spec.ts`

**Interfaces:**
- Preserves: the existing `quality`, `test`, and `container-build` jobs and their commands, immutable action SHAs, timeouts, and read-only permissions.
- Consumes: successful `container-build` and SSH command `deploy <sha>` from Task 1.
- Produces: `workflow_dispatch` support and a `deploy-production` job that runs only for `refs/heads/main`.
- Consumes GitHub Environment secrets: `PRODUCTION_HOST`, `PRODUCTION_USER`, `PRODUCTION_SSH_KEY`, `PRODUCTION_HOST_KEY`.

- [ ] **Step 1: Update the existing contract test to fail on the CD requirements**

Change the `node:fs/promises` import to `import { readFile, readdir } from 'node:fs/promises';`. In `WorkflowJob`, add the fields used by the deployment job while keeping the existing fields:

```ts
interface WorkflowJob {
  concurrency?: {
    group?: string;
    'cancel-in-progress'?: boolean;
  };
  'continue-on-error'?: unknown;
  environment?: string;
  if?: unknown;
  needs?: string[];
  permissions?: Record<string, string>;
  'runs-on'?: string;
  steps?: WorkflowStep[];
  'timeout-minutes'?: number;
}
```

Normalize the existing `uses:` line check so it is portable across LF and CRLF checkouts:

```ts
const usesLines = workflowText
  .split('\n')
  .map((line) => line.trimEnd())
  .filter((line) => line.trimStart().startsWith('uses:'));
```

Rename the existing test to `runs the exact verification jobs without publishing`. Add `workflow_dispatch?: unknown` to `WorkflowDocument.on` and widen `WorkflowDocument.concurrency['cancel-in-progress']` to `boolean | string`, because GitHub expressions parse as strings. Change the existing job-key assertion to require all four jobs:

```ts
expect(Object.keys(jobs).sort()).toEqual(
  ['container-build', 'deploy-production', 'quality', 'test'].sort(),
);
```

Keep the exact assertions for `quality`, `test`, and `container-build`. Scope their no-secret/no-deploy assertions to those three jobs instead of the entire workflow. Add this test for the new job:

```ts
it('deploys only tested main commits through restricted SSH', async () => {
  const workflowText = await readFile('.github/workflows/ci.yml', 'utf8');
  const workflow = parse(workflowText) as WorkflowDocument;
  const deploy = workflow.jobs?.['deploy-production'];

  expect(workflow.on).toHaveProperty('workflow_dispatch');
  expect(workflow.concurrency).toEqual({
    group:
      'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
  });
  expect(deploy).toMatchObject({
    if: "github.event_name != 'pull_request' && github.ref == 'refs/heads/main'",
    needs: ['container-build'],
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 30,
    environment: 'production',
    concurrency: {
      group: 'volley-bot-production',
      'cancel-in-progress': false,
    },
  });
  expect(deploy?.steps?.some((step) => step.uses !== undefined)).toBe(false);

  const commands = commandsFor(deploy!).join('\n');
  expect(commands).toContain('StrictHostKeyChecking=yes');
  expect(commands).toContain('IdentitiesOnly=yes');
  expect(commands).toContain('deploy ${GITHUB_SHA}');
  expect(commands).not.toMatch(/BOT_TOKEN|DATABASE_URL|REDIS_URL|TELEGRAM_WEBHOOK_SECRET/);
  expect(
    (await readdir('.github/workflows')).filter((name) => /\.ya?ml$/i.test(name)),
  ).toEqual(['ci.yml']);
});
```

Add these assertions so secrets cannot leak into a pull-request-capable job and the deployment job cannot gain application secrets:

```ts
const verificationJobs = [quality, test, containerBuild];
expect(JSON.stringify(verificationJobs)).not.toMatch(/secrets\./);
expect(
  [...workflowText.matchAll(/secrets\.([A-Z0-9_]+)/g)]
    .map((match) => match[1])
    .sort(),
).toEqual(
  [
    'PRODUCTION_HOST',
    'PRODUCTION_HOST_KEY',
    'PRODUCTION_SSH_KEY',
    'PRODUCTION_USER',
  ].sort(),
);
```

Preserve the checks that all `uses:` lines in the existing verification jobs are pinned to 40-character SHAs.

- [ ] **Step 2: Run the contract test and confirm the expected red state**

Run: `pnpm vitest run tests/release/github-actions-ci.spec.ts`

Expected: FAIL because the existing workflow has no `workflow_dispatch`, still cancels every superseded run, and has no `deploy-production` job. The existing `quality`, `test`, and `container-build` assertions must remain green.

- [ ] **Step 3: Extend `.github/workflows/ci.yml` without replacing its verification jobs**

Add the manual trigger:

```yaml
on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:
```

Change only the cancellation expression in the existing workflow-level concurrency block so pull-request runs remain cancellable while `main` and manual runs cannot be interrupted during deployment:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Leave `quality`, `test`, and `container-build` otherwise unchanged. Append:

```yaml
  deploy-production:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    needs:
      - container-build
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production
    concurrency:
      group: volley-bot-production
      cancel-in-progress: false
    steps:
      - name: Configure restricted SSH identity
        env:
          PRODUCTION_SSH_KEY: ${{ secrets.PRODUCTION_SSH_KEY }}
          PRODUCTION_HOST_KEY: ${{ secrets.PRODUCTION_HOST_KEY }}
        run: |
          install -m 0700 -d "$HOME/.ssh"
          printf '%s\n' "$PRODUCTION_SSH_KEY" >"$HOME/.ssh/id_ed25519"
          printf '%s\n' "$PRODUCTION_HOST_KEY" >"$HOME/.ssh/known_hosts"
          chmod 0600 "$HOME/.ssh/id_ed25519" "$HOME/.ssh/known_hosts"
      - name: Deploy tested commit
        env:
          PRODUCTION_HOST: ${{ secrets.PRODUCTION_HOST }}
          PRODUCTION_USER: ${{ secrets.PRODUCTION_USER }}
        run: |
          ssh -i "$HOME/.ssh/id_ed25519" \
            -o BatchMode=yes \
            -o IdentitiesOnly=yes \
            -o StrictHostKeyChecking=yes \
            "$PRODUCTION_USER@$PRODUCTION_HOST" "deploy ${GITHUB_SHA}"
```

Do not add checkout, repository credentials, application secrets, or third-party SSH actions to `deploy-production`. The full SHA comes from the immutable GitHub event context. A manual run selected for any ref other than `main` skips deployment.

- [ ] **Step 4: Validate the extended workflow policy and formatting**

Run: `pnpm vitest run tests/release/github-actions-ci.spec.ts tests/release/production-deploy.spec.ts`

Run: `pnpm exec prettier --check .github/workflows/ci.yml tests/release/github-actions-ci.spec.ts`

Expected: both policy suites and the formatting check pass. The existing Compose validation and production image build assertions remain present. After push, inspect the rendered `CI` workflow in GitHub Actions; GitHub must accept it without a syntax error and must not show a second CI/CD workflow.

- [ ] **Step 5: Commit the workflow extension**

```bash
git add .github/workflows/ci.yml tests/release/github-actions-ci.spec.ts
git commit -m "ci: deploy tested main commits to production"
```

---

### Task 3: Document and perform the one-time VDS bootstrap

**Files:**
- Create: `docs/operations/production-cd.md`

**Interfaces:**
- Installs Task 1 templates outside the checkout.
- Produces VDS user `volley-deploy`, sudo rule `/etc/sudoers.d/volley-deploy`, and state directory `/var/lib/volley-bot-deploy`.
- Produces one dedicated Ed25519 public/private key pair; only the public key is copied to the VDS.

- [ ] **Step 1: Write the operations document with exact prerequisites**

Document the fixed deployment paths and prerequisites:

```text
Host: npoletaev97.fvds.ru
Repository: /opt/volley-bot
Environment: /etc/volley-bot/production.env
Base compose: /opt/volley-bot/compose.yaml
Production override: /opt/volley-bot/compose.prod.yaml
Public readiness: ${PUBLIC_BASE_URL}/health/ready
Deployment account: volley-deploy
```

State that the current personal/root SSH key is not reused and that private-key contents must never be pasted into logs, issues, PRs, commits, or chat.

- [ ] **Step 2: Generate the dedicated key on a trusted operator machine**

Run outside the repository so neither key can be staged accidentally:

```bash
ssh-keygen -t ed25519 -a 64 -C github-actions-volley-bot -f volley-bot-actions-ed25519
```

Expected: `volley-bot-actions-ed25519` is private and will become `PRODUCTION_SSH_KEY`; `volley-bot-actions-ed25519.pub` is the only key file copied to the server. Do not print the private file.

- [ ] **Step 3: Verify exact VDS targets before changing them**

Connect using the already authorized operator SSH path and run read-only checks:

```bash
getent passwd volley-deploy || true
test -d /opt/volley-bot && readlink -f /opt/volley-bot
test -f /etc/volley-bot/production.env && stat -c '%a %U:%G %n' /etc/volley-bot/production.env
test -f /opt/volley-bot/compose.prod.yaml
test -f /opt/volley-bot/Caddyfile
docker compose version
git -C /opt/volley-bot status --short --untracked-files=no
```

Expected: repository and secret file paths match exactly, Docker Compose v2 is installed, and the tracked production checkout is clean. Stop and investigate rather than overwriting tracked server changes.

- [ ] **Step 4: Install the account, dispatcher, wrapper, and sudo rule**

From a trusted checkout of the same reviewed commit, copy templates to temporary server paths, then install them as root:

```bash
useradd --create-home --shell /bin/bash volley-deploy
passwd -l volley-deploy
install -d -m 0700 -o volley-deploy -g volley-deploy /home/volley-deploy/.ssh
install -m 0755 -o root -g root /tmp/volley-deploy-dispatch /usr/local/bin/volley-deploy-dispatch
install -m 0750 -o root -g root /tmp/deploy-volley-bot /usr/local/sbin/deploy-volley-bot
install -d -m 0750 -o root -g root /var/lib/volley-bot-deploy
```

Create `/etc/sudoers.d/volley-deploy` with exactly:

```sudoers
volley-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-volley-bot --stdin
```

Validate before ending the root session:

```bash
chmod 0440 /etc/sudoers.d/volley-deploy
visudo -cf /etc/sudoers.d/volley-deploy
```

If the account already exists, do not rerun `useradd`; verify its home and shell and continue idempotently.

- [ ] **Step 5: Install the forced public key**

Create `/home/volley-deploy/.ssh/authorized_keys` with one line. Replace `<PUBLIC_KEY>` with the single line from `volley-bot-actions-ed25519.pub`:

```text
restrict,command="/usr/local/bin/volley-deploy-dispatch",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty <PUBLIC_KEY>
```

Then run:

```bash
chown volley-deploy:volley-deploy /home/volley-deploy/.ssh/authorized_keys
chmod 0600 /home/volley-deploy/.ssh/authorized_keys
```

The duplicate explicit restrictions are intentional documentation of the policy even though modern OpenSSH `restrict` already disables them.

- [ ] **Step 6: Capture and verify the server host key**

On the VDS, obtain the public fingerprint without displaying private material:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the trusted operator machine, collect:

```bash
ssh-keyscan -t ed25519 npoletaev97.fvds.ru >volley-bot-known-hosts
ssh-keygen -lf volley-bot-known-hosts
```

Expected: fingerprints match exactly. The single `known_hosts` line becomes `PRODUCTION_HOST_KEY`. A mismatch is a hard stop.

- [ ] **Step 7: Test restriction and one dry failure safely**

With the dedicated key, verify that an interactive command is rejected:

```bash
ssh -i volley-bot-actions-ed25519 \
  -o UserKnownHostsFile=volley-bot-known-hosts \
  -o StrictHostKeyChecking=yes \
  volley-deploy@npoletaev97.fvds.ru 'uname -a'
```

Expected: nonzero exit with `invalid deploy command`; it must not print system information.

Then verify malformed deploy input is rejected:

```bash
ssh -i volley-bot-actions-ed25519 \
  -o UserKnownHostsFile=volley-bot-known-hosts \
  -o StrictHostKeyChecking=yes \
  volley-deploy@npoletaev97.fvds.ru 'deploy not-a-sha'
```

Expected: nonzero exit before `git fetch`, Docker, or any service change.

- [ ] **Step 8: Commit the operations document**

```bash
git add docs/operations/production-cd.md
git commit -m "docs: document production CD bootstrap"
```

---

### Task 4: Configure GitHub production protection and run the first deployment

**Files:**
- Modify only if corrections are required: `.github/workflows/ci.yml`
- Modify only if corrections are required: `docs/operations/production-cd.md`

**Interfaces:**
- Consumes the four `production` Environment secrets from Task 2.
- Produces a protected `production` deployment environment and required `quality`, `test`, and `container-build` branch checks.

- [ ] **Step 1: Create and restrict the GitHub Environment**

In repository `emris97/volley-bot`, open **Settings → Environments → New environment**, create `production`, and allow deployments only from the `main` branch. Do not add required reviewers because deployment is intended to be automatic after merge.

Add these environment secrets without printing their values:

```text
PRODUCTION_HOST=npoletaev97.fvds.ru
PRODUCTION_USER=volley-deploy
PRODUCTION_SSH_KEY=<contents of dedicated private key>
PRODUCTION_HOST_KEY=<verified known_hosts line>
```

Delete the local private key after confirming the GitHub secret is stored only if the user has an approved encrypted recovery copy; otherwise retain it in an approved password manager, never in the repository.

- [ ] **Step 2: Protect `main` from untested direct pushes**

In **Settings → Rules → Rulesets**, create an active branch ruleset targeting the default branch and require:

- pull requests before merging;
- the `quality`, `test`, and `container-build` status checks;
- branches to be up to date before merging;
- conversation resolution;
- no bypass for ordinary contributors.

Do not require the `deploy-production` check for merge; it runs only after the commit reaches `main`.

- [ ] **Step 3: Push the implementation branch and inspect the PR quality run**

Push the branch containing both implementation plans' completed changes and open a PR to `main`.

Expected: `quality`, `test`, and `container-build` pass, and `deploy-production` is skipped for the pull request.

- [ ] **Step 4: Merge and follow the serialized production deployment**

After review, merge the PR. In **Actions → CI**, verify:

1. the workflow event is a push to `refs/heads/main`;
2. `quality`, `test`, and `container-build` pass for the merge SHA;
3. exactly one `deploy-production` job starts after `container-build`;
4. the SSH output ends with `deployed revision <merge-sha>`;
5. no application secret, private key, signed start parameter, or environment-file content appears in logs.

- [ ] **Step 5: Verify the VDS and Telegram after the first deploy**

Using the operator SSH account, run read-only verification:

```bash
cat /var/lib/volley-bot-deploy/current
git -C /opt/volley-bot rev-parse HEAD
docker compose --env-file /etc/volley-bot/production.env -f /opt/volley-bot/compose.yaml -f /opt/volley-bot/compose.prod.yaml ps
```

Expected: the first two SHAs equal the merged GitHub SHA; PostgreSQL, Redis, Caddy, API, and worker are healthy. Call the public readiness endpoint from a trusted machine and expect HTTP 200.

Perform the onboarding smoke test from the application plan. Inspect Telegram webhook information without printing the bot token into task output; pending updates must not grow.

- [ ] **Step 6: Prove the rollback path without changing production state**

Run read-only checks:

```bash
cat /var/lib/volley-bot-deploy/previous
git -C /opt/volley-bot merge-base --is-ancestor "$(cat /var/lib/volley-bot-deploy/previous)" origin/main
```

Expected: the previous SHA exists and is reachable from `origin/main`. Document the actual rollback command, but do not execute it during a healthy deployment:

```bash
sudo /usr/local/sbin/deploy-volley-bot rollback "$(cat /var/lib/volley-bot-deploy/previous)"
```

- [ ] **Step 7: Run final repository verification and report evidence**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
git status --short
```

Expected: all gates exit 0 and only the pre-existing untracked `.pnpm-store/` may remain. Report the GitHub run URL, merged SHA, deployed SHA, readiness result, and Telegram smoke-test result without reporting secrets.
