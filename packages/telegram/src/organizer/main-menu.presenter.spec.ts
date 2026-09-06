import { describe, expect, it } from 'vitest';
import { asGroupId } from '@volley/domain';
import {
  renderOrganizerHome,
  renderOrganizerGroupPicker,
} from './main-menu.presenter.js';

const group = (title: string, selected = true) => ({
  groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424611'),
  telegramChatId: '-1001' as never,
  title,
  timeZone: 'Europe/Astrakhan',
  selected,
});

describe('organizer main menu presenter', () => {
  it('renders the selected group title safely and the approved home actions', () => {
    expect(renderOrganizerHome([group('Тест <группа> & друзья')])).toEqual({
      text: '<b>Главное меню</b>\n\nГруппа: <b>Тест &lt;группа&gt; &amp; друзья</b>',
      parseMode: 'HTML',
      keyboard: [
        [{ text: 'Создать игру', callbackData: 'om:v1:new' }],
        [
          {
            text: 'Предстоящие игры',
            callbackData: 'om:v1:games:upcoming',
          },
        ],
        [
          {
            text: 'Прошедшие игры',
            callbackData: 'om:v1:games:past',
          },
        ],
        [{ text: 'Шаблоны', callbackData: 'om:v1:templates' }],
        [{ text: 'Настройки группы', callbackData: 'om:v1:settings' }],
        [{ text: 'Помощь', callbackData: 'om:v1:help' }],
      ],
    });
  });

  it('adds the group picker only when multiple verified groups are available', () => {
    const first = group('Первая');
    const second = {
      ...group('Вторая', false),
      groupId: asGroupId('018f6ba0-62d2-7bd1-8f13-12e0c8424612'),
    };

    expect(renderOrganizerHome([first, second]).keyboard).toContainEqual([
      { text: 'Выбрать группу', callbackData: 'om:v1:groups' },
    ]);
  });

  it('renders a group picker with safe titles', () => {
    expect(renderOrganizerGroupPicker([group('A < B')])).toEqual({
      text: '<b>Выберите группу</b>\n\nA &lt; B',
      parseMode: 'HTML',
      keyboard: [
        [
          {
            text: 'A < B',
            callbackData: 'om:v1:group:018f6ba0-62d2-7bd1-8f13-12e0c8424611',
          },
        ],
        [{ text: 'Назад', callbackData: 'om:v1:home' }],
      ],
    });
  });

  it('explains how to add a group when no verified group is available', () => {
    expect(renderOrganizerHome([])).toEqual({
      text: 'У вас нет доступных групп.\n\nДобавьте бота в группу и завершите настройку.',
      parseMode: 'HTML',
      keyboard: [],
    });
  });
});
