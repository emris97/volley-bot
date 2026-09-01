import type { GameId, GameState, GroupId, TelegramId } from '@volley/domain';

export interface GameMessageView {
  groupId: GroupId;
  gameId: GameId;
  telegramChatId: TelegramId;
  canonicalMessageId: bigint | null;
  pinMessage: boolean;
  name: string;
  venue: string;
  address: string | null;
  startsAt: Date;
  timeZone: string;
  state: GameState;
  capacity: number;
  roster: readonly string[];
  waitlist: readonly string[];
  tentative: readonly string[];
}

export interface TelegramButton {
  text: string;
  callbackData: string;
}

export interface RenderedTelegramMessage {
  text: string;
  parseMode: 'HTML';
  keyboard: readonly (readonly TelegramButton[])[];
}
