import {
  AuthorizationDeniedError,
  type TelegramGateway,
} from '@volley/application';
import type { GameId, GroupId, TelegramId, UserId } from '@volley/domain';

export interface LiveOrganizerGameDirectory {
  resolveGameGroup(gameId: GameId): Promise<{
    groupId: GroupId;
    telegramChatId: TelegramId;
  } | null>;
  refreshMembership(input: {
    groupId: GroupId;
    telegramUserId: TelegramId;
    role: 'OWNER' | 'ADMIN' | 'MEMBER';
    status: 'ACTIVE' | 'LEFT';
  }): Promise<UserId>;
}

export class LiveOrganizerGameActorResolver {
  public constructor(
    private readonly telegram: Pick<TelegramGateway, 'getChatMember'>,
    private readonly directory: LiveOrganizerGameDirectory,
  ) {}

  public async resolve(
    gameId: GameId,
    telegramUserId: TelegramId,
  ): Promise<{ groupId: GroupId; gameId: GameId; userId: UserId }> {
    const location = await this.directory.resolveGameGroup(gameId);
    if (location === null) throw new Error('Игра не найдена.');

    const member = await this.telegram.getChatMember(
      location.telegramChatId,
      telegramUserId,
    );
    const role =
      member.status === 'creator'
        ? 'OWNER'
        : member.status === 'administrator'
          ? 'ADMIN'
          : null;
    const userId = await this.directory.refreshMembership({
      groupId: location.groupId,
      telegramUserId,
      role: role ?? 'MEMBER',
      status: role === null ? 'LEFT' : 'ACTIVE',
    });
    if (role === null) throw new AuthorizationDeniedError();

    return { groupId: location.groupId, gameId, userId };
  }
}

export const organizerAccessDeniedText =
  'Управление доступно только администраторам группы.';

export const isOrganizerAuthorizationDenied = (error: unknown): boolean =>
  error instanceof AuthorizationDeniedError ||
  (error instanceof Error && error.name === 'AuthorizationDeniedError');
