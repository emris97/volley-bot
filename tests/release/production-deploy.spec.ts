import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFile(new URL(`../../deploy/production/${name}`, import.meta.url), 'utf8');

describe('production deployment scripts', () => {
  it('restricts the SSH dispatcher to one root wrapper invocation', async () => {
    const script = await read('volley-deploy-dispatch');

    expect(script).toContain('SSH_ORIGINAL_COMMAND');
    expect(script).toContain(
      'sudo -n /usr/local/sbin/deploy-volley-bot --stdin',
    );
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
    expect(script).toContain('logs --tail=200 api worker');
    expect(script).not.toMatch(
      /rm\s+-rf|git\s+clean|production\.env.*(?:cat|echo)/,
    );
  });
});
