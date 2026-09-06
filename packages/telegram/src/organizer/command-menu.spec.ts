import { describe, expect, it } from 'vitest';
import { PRIVATE_COMMANDS } from './command-menu.js';

describe('PRIVATE_COMMANDS', () => {
  it('advertises the approved Russian private command menu', () => {
    expect(PRIVATE_COMMANDS).toEqual([
      { command: 'start', description: 'Главное меню' },
      { command: 'games', description: 'Мои игры' },
      { command: 'newgame', description: 'Создать игру' },
      { command: 'templates', description: 'Шаблоны игр' },
      { command: 'settings', description: 'Настройки группы' },
      { command: 'help', description: 'Помощь' },
    ]);
  });
});
