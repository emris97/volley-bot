import { GrammyError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { safelyEditTelegramMessage } from './safe-message-edit.js';

describe('safelyEditTelegramMessage', () => {
  it('accepts Telegram message-is-not-modified retries', async () => {
    const error = new GrammyError(
      'Call to editMessageText failed!',
      {
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      },
      'editMessageText',
      {},
    );
    await expect(
      safelyEditTelegramMessage(() => Promise.reject(error)),
    ).resolves.toBeUndefined();
  });

  it('does not swallow unrelated Telegram failures', async () => {
    const error = new GrammyError(
      'Call to editMessageText failed!',
      { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' },
      'editMessageText',
      {},
    );
    await expect(
      safelyEditTelegramMessage(() => Promise.reject(error)),
    ).rejects.toBe(error);
  });
});
