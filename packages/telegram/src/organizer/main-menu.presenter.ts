import type { OrganizerGroupCandidate } from '@volley/application';

export interface OrganizerView {
  text: string;
  parseMode: 'HTML';
  keyboard: readonly (readonly {
    text: string;
    callbackData: string;
  }[])[];
}

export const renderOrganizerHome = (
  groups: readonly OrganizerGroupCandidate[],
): OrganizerView => {
  if (groups.length === 0) {
    return renderNoGroupsHome();
  }

  const selected = groups.find((group) => group.selected) ?? groups.at(0);
  if (selected === undefined) return renderNoGroupsHome();
  return {
    text: `<b>Главное меню</b>\n\nГруппа: <b>${escapeHtml(selected.title)}</b>`,
    parseMode: 'HTML',
    keyboard: [
      [{ text: 'Создать игру', callbackData: 'om:v1:new' }],
      [{ text: 'Предстоящие игры', callbackData: 'om:v1:games:upcoming' }],
      [{ text: 'Прошедшие игры', callbackData: 'om:v1:games:past' }],
      [{ text: 'Шаблоны', callbackData: 'om:v1:templates' }],
      ...(groups.length >= 2
        ? [[{ text: 'Выбрать группу', callbackData: 'om:v1:groups' }]]
        : []),
      [{ text: 'Настройки группы', callbackData: 'om:v1:settings' }],
      [{ text: 'Помощь', callbackData: 'om:v1:help' }],
    ],
  };
};

export const renderOrganizerGroupPicker = (
  groups: readonly OrganizerGroupCandidate[],
): OrganizerView => ({
  text: `<b>Выберите группу</b>\n\n${groups
    .map((group) => escapeHtml(group.title))
    .join('\n')}`,
  parseMode: 'HTML',
  keyboard: [
    ...groups.map((group) => [
      {
        text: group.title,
        callbackData: `om:v1:group:${group.groupId}`,
      },
    ]),
    [{ text: 'Назад', callbackData: 'om:v1:home' }],
  ],
});

const renderNoGroupsHome = (): OrganizerView => ({
  text: 'У вас нет доступных групп.\n\nДобавьте бота в группу и завершите настройку.',
  parseMode: 'HTML',
  keyboard: [],
});

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
