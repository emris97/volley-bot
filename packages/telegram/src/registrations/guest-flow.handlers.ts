import type { RegisterGuest } from '@volley/application';
import type { GameId, TelegramId } from '@volley/domain';
import type { RegistrationActorResolver } from './registration.handlers.js';
import type { SignedStartToken } from '../signed-start-token.js';

export interface GuestRegistrationDraft {
  telegramUserId: TelegramId;
  gameId: GameId;
  expiresAt: string;
}

export interface GuestRegistrationDraftRepository {
  load(telegramUserId: TelegramId): Promise<GuestRegistrationDraft | null>;
  save(draft: GuestRegistrationDraft): Promise<void>;
  clear(telegramUserId: TelegramId): Promise<void>;
}

type GuestRegistrationUseCase = Pick<RegisterGuest, 'execute'>;

export class GuestFlowHandlers {
  public constructor(
    private readonly signer: SignedStartToken,
    private readonly drafts: GuestRegistrationDraftRepository,
    private readonly actors: RegistrationActorResolver,
    private readonly registerGuest: GuestRegistrationUseCase,
  ) {}

  public async handleStart(input: {
    telegramUserId: TelegramId;
    token: string;
    now?: Date;
  }): Promise<void> {
    const payload = this.signer.verify(input.token, input.now);
    if (payload.purpose !== 'add-guest') {
      throw new Error('Start token is not for adding a guest');
    }
    if (payload.inviterTelegramId !== input.telegramUserId) {
      throw new Error('Guest token belongs to another inviter');
    }
    await this.drafts.save({
      telegramUserId: input.telegramUserId,
      gameId: payload.gameId,
      expiresAt: payload.expiresAt,
    });
  }

  public async handleName(input: {
    telegramUserId: TelegramId;
    text: string;
    updateId: number;
    now?: Date;
  }): Promise<boolean> {
    const draft = await this.drafts.load(input.telegramUserId);
    if (draft === null) return false;
    if (Date.parse(draft.expiresAt) <= (input.now ?? new Date()).getTime()) {
      await this.drafts.clear(input.telegramUserId);
      throw new Error('Guest registration flow expired');
    }
    const guestDisplayName = input.text.trim();
    if (guestDisplayName.length === 0 || [...guestDisplayName].length > 80) {
      throw new Error('Guest name must contain between 1 and 80 characters');
    }
    const actor = await this.actors.resolve(draft.gameId, input.telegramUserId);
    await this.registerGuest.execute({
      groupId: actor.groupId,
      gameId: actor.gameId,
      inviterUserId: actor.userId,
      guestDisplayName,
      idempotencyKey: `guest-name:${input.updateId}`,
    });
    await this.drafts.clear(input.telegramUserId);
    return true;
  }
}
