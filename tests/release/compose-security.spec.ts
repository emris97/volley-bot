import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Compose security contract', () => {
  it('requires production secrets and publishes no host ports in the base file', async () => {
    const compose = await readFile('compose.yaml', 'utf8');

    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'POSTGRES_PASSWORD',
      'REDIS_PASSWORD',
    ]) {
      expect(compose).toContain(`\${${name}:?`);
    }
    expect(compose).not.toMatch(/\n\s+ports:/);
    expect(compose).not.toContain('replace_with_a_real');
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:-volley/);
    expect(compose).toContain('--requirepass');
    expect(compose).toContain('$$REDIS_PASSWORD');
  });

  it('keeps permissive local values and published ports in an explicit overlay', async () => {
    const [developmentCompose, developmentEnvironment] = await Promise.all([
      readFile('compose.dev.yaml', 'utf8'),
      readFile('.env.compose.example', 'utf8'),
    ]);

    expect(developmentCompose).toMatch(/\n\s+ports:/);
    expect(developmentEnvironment).toContain('POSTGRES_PASSWORD=volley-local');
    expect(developmentEnvironment).toContain('REDIS_PASSWORD=redis-local');
    expect(developmentEnvironment).toContain(
      'DATABASE_URL=postgresql://volley:volley-local@postgres:5432/volley',
    );
    expect(developmentEnvironment).toContain(
      'REDIS_URL=redis://:redis-local@redis:6379',
    );
  });
});
