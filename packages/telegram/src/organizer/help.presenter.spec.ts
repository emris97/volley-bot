import { describe, expect, it } from 'vitest';
import { renderOrganizerHelp } from './help.presenter.js';

describe('renderOrganizerHelp', () => {
  it('explains the complete organizer journey without internal identifiers or legacy commands', () => {
    const view = renderOrganizerHelp();

    for (const expected of [
      'шаблон',
      'игр',
      'регистрац',
      'заверш',
      'посещаемост',
      'оплат',
      'личном чате',
    ]) {
      expect(view.text.toLocaleLowerCase('ru-RU')).toContain(expected);
    }
    expect(view.text).not.toMatch(
      /gameId|UUID|\/manage|\/attendance|\/payment/i,
    );
  });
});
