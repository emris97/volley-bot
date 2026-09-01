declare const identityBrand: unique symbol;

type Identity<Name extends string> = string & {
  readonly [identityBrand]: Name;
};

export type UserId = Identity<'UserId'>;
export type GroupId = Identity<'GroupId'>;
export type TelegramId = Identity<'TelegramId'>;

export const asUserId = (value: string): UserId => value as UserId;
export const asGroupId = (value: string): GroupId => value as GroupId;
export const asTelegramId = (value: string): TelegramId => value as TelegramId;
