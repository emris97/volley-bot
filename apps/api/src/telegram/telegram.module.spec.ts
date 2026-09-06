import { describe, expect, it, vi } from 'vitest';
import { registerProductionTelegramHandlers } from './telegram.module.js';

describe('production Telegram handler assembly', () => {
  it('registers the complete runtime in the binding order', () => {
    const trace: string[] = [];
    const bot = {
      use: vi.fn(() => {
        trace.push('use');
        return bot;
      }),
      command: vi.fn((command: string) => {
        trace.push(`command:${command}`);
        return bot;
      }),
      callbackQuery: vi.fn((pattern: RegExp) => {
        trace.push(`callback:${pattern.source}`);
        return bot;
      }),
      on: vi.fn((filter: string) => {
        trace.push(`on:${filter}`);
        return bot;
      }),
    };

    registerProductionTelegramHandlers(bot as never, {
      privateDirectory: {} as never,
      payments: {} as never,
      attendance: {} as never,
      templates: {} as never,
      gameCreation: {} as never,
      organizerMenu: {} as never,
      groupSettings: {} as never,
      management: {} as never,
      onboarding: {} as never,
      guests: {} as never,
      registrations: {} as never,
      tentative: {} as never,
    });

    expect(trace).toEqual([
      'use',
      'command:payment',
      'on:message:text',
      'callback:^pay:',
      'command:attendance',
      'on:message:text',
      'callback:^at:',
      'command:templates',
      'callback:^tw:v1:',
      'on:message:text',
      'command:newgame',
      'callback:^gc:v1:',
      'on:message:text',
      'command:games',
      'command:newgame',
      'command:templates',
      'command:settings',
      'command:help',
      'callback:^om:',
      'callback:^gs:v1:',
      'command:manage',
      'callback:^v1:manage:',
      'callback:^ga:',
      'callback:^mg:',
      'on:message:text',
      'on:my_chat_member',
      'command:start',
      'on:message:text',
      'callback:^cfg:',
      'callback:^v1:',
      'callback:^tc:',
    ]);
  });
});
