# Production CD bootstrap

This runbook prepares the existing VDS for restricted deployments from GitHub Actions. Run it once from a trusted operator machine after the deployment changes have been reviewed. Do not execute any mutating command until every read-only prerequisite check matches the paths below.

## Fixed production targets

```text
Host: npoletaev97.fvds.ru
Repository: /opt/volley-bot
Environment: /etc/volley-bot/production.env
Base compose: /opt/volley-bot/compose.yaml
Production override: /opt/volley-bot/compose.prod.yaml
Public readiness: ${PUBLIC_BASE_URL}/health/ready
Deployment account: volley-deploy
```

The deployment uses a new, dedicated Ed25519 key. Do not reuse a personal or root SSH key. Never paste the private key into logs, issues, pull requests, commits, or chat.

## 1. Generate the deployment identity

Run outside the repository so neither key can be staged accidentally:

```bash
ssh-keygen -t ed25519 -a 64 -C github-actions-volley-bot -f volley-bot-actions-ed25519
```

`volley-bot-actions-ed25519` is the private key and becomes the GitHub Environment secret `PRODUCTION_SSH_KEY`. `volley-bot-actions-ed25519.pub` is the only key file copied to the VDS. Do not print the private file.

## 2. Verify the VDS before changing it

Connect using the existing authorized operator SSH path and run only these read-only checks:

```bash
getent passwd volley-deploy || true
test -d /opt/volley-bot && readlink -f /opt/volley-bot
test -f /etc/volley-bot/production.env && stat -c '%a %U:%G %n' /etc/volley-bot/production.env
test -f /opt/volley-bot/compose.prod.yaml
test -f /opt/volley-bot/Caddyfile
docker compose version
git -C /opt/volley-bot status --short --untracked-files=no
```

The repository and secret-file paths must match exactly, Docker Compose v2 must be installed, and the tracked production checkout must be clean. Stop and investigate any mismatch; do not overwrite tracked server changes.

## 3. Install the restricted deployment path

From a trusted checkout of the reviewed commit, copy `deploy/production/volley-deploy-dispatch` and `deploy/production/deploy-volley-bot` to `/tmp` on the VDS. Then, as root, install the account and root-owned programs:

```bash
useradd --create-home --shell /bin/bash volley-deploy
passwd -l volley-deploy
install -d -m 0700 -o volley-deploy -g volley-deploy /home/volley-deploy/.ssh
install -m 0755 -o root -g root /tmp/volley-deploy-dispatch /usr/local/bin/volley-deploy-dispatch
install -m 0750 -o root -g root /tmp/deploy-volley-bot /usr/local/sbin/deploy-volley-bot
install -d -m 0750 -o root -g root /var/lib/volley-bot-deploy
```

If `volley-deploy` already exists, do not rerun `useradd`; verify its home and shell and continue idempotently.

Create `/etc/sudoers.d/volley-deploy` with exactly:

```sudoers
volley-deploy ALL=(root) NOPASSWD: /usr/local/sbin/deploy-volley-bot --stdin
```

Validate the rule before ending the root session:

```bash
chmod 0440 /etc/sudoers.d/volley-deploy
visudo -cf /etc/sudoers.d/volley-deploy
```

## 4. Install the forced public key

Create `/home/volley-deploy/.ssh/authorized_keys` as a one-line file. Replace `<PUBLIC_KEY>` with the single line from `volley-bot-actions-ed25519.pub`:

```text
restrict,command="/usr/local/bin/volley-deploy-dispatch",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty <PUBLIC_KEY>
```

Then enforce ownership and permissions:

```bash
chown volley-deploy:volley-deploy /home/volley-deploy/.ssh/authorized_keys
chmod 0600 /home/volley-deploy/.ssh/authorized_keys
```

The duplicate explicit restrictions are intentional policy documentation even though modern OpenSSH `restrict` already disables them.

## 5. Pin the VDS host key

On the VDS, display the public host-key fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On the trusted operator machine, collect and inspect the public host key:

```bash
ssh-keyscan -t ed25519 npoletaev97.fvds.ru >volley-bot-known-hosts
ssh-keygen -lf volley-bot-known-hosts
```

The fingerprints must match exactly. A mismatch is a hard stop. The single `known_hosts` line becomes the GitHub Environment secret `PRODUCTION_HOST_KEY`.

## 6. Test the forced-command boundary

First verify that an unrelated command is rejected:

```bash
ssh -i volley-bot-actions-ed25519 \
  -o UserKnownHostsFile=volley-bot-known-hosts \
  -o StrictHostKeyChecking=yes \
  volley-deploy@npoletaev97.fvds.ru 'uname -a'
```

This must exit nonzero with `invalid deploy command` and must not print system information. Then verify malformed deploy input:

```bash
ssh -i volley-bot-actions-ed25519 \
  -o UserKnownHostsFile=volley-bot-known-hosts \
  -o StrictHostKeyChecking=yes \
  volley-deploy@npoletaev97.fvds.ru 'deploy not-a-sha'
```

This must exit nonzero before `git fetch`, Docker, or any service change.

## 7. Configure the GitHub production environment

Create the GitHub Environment `production`, restrict it to the `main` branch, and add only these secrets:

- `PRODUCTION_HOST=npoletaev97.fvds.ru`
- `PRODUCTION_USER=volley-deploy`
- `PRODUCTION_SSH_KEY` containing the dedicated private key
- `PRODUCTION_HOST_KEY` containing the verified `known_hosts` line

Application secrets remain exclusively in `/etc/volley-bot/production.env`; they are not GitHub Actions secrets for this workflow.

Protect `main` with an active branch ruleset that requires pull requests, up-to-date branches, resolved conversations, and the `quality`, `test`, and `container-build` status checks. Do not require `deploy-production`: that job runs only after a reviewed commit reaches `main`. Do not grant bypass to ordinary contributors.

## Rollback

The deployment wrapper records the current and previous known-good revisions under `/var/lib/volley-bot-deploy`. Inspect the previous revision and invoke rollback locally on the VDS:

```bash
cat /var/lib/volley-bot-deploy/previous
sudo /usr/local/sbin/deploy-volley-bot rollback "$(cat /var/lib/volley-bot-deploy/previous)"
```

Rollback uses the same ancestry validation, build, migration, health, and readiness path as a normal deployment. Do not run it as a smoke test against a healthy production deployment.
