import { describe, expect, it, vi } from 'vitest';
import { asTelegramId } from '@volley/domain';
import { GrammyTelegramGateway } from './bot.factory.js';

describe('GrammyTelegramGateway', () => {
  it('treats an unchanged edit as an idempotent success', async () => {
    const bot = {
      api: {
        editMessageText: vi
          .fn()
          .mockRejectedValue(new Error('Bad Request: message is not modified')),
      },
    };
    const gateway = new GrammyTelegramGateway(bot as never);

    await expect(
      gateway.editMessage(asTelegramId('-1001'), 42n, 'same text'),
    ).resolves.toBeUndefined();
  });
});
