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
