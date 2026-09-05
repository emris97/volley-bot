import type {
  AuthorizationService,
  ConfigureGroup,
  OnboardGroup,
  TelegramGateway,
} from '@volley/application';
import {
  asTelegramId,
  type Group,
  type GroupId,
  type TelegramId,
} from '@volley/domain';
import { TelegramMessageNotEditableError } from './messages/game-message-updater.js';
import {
  nextWizardCode,
  OnboardingInputError,
  parseOnboardingCallback,
  parseWizardProgress,
  type CompleteWizardProgress,
} from './group-onboarding.model.js';
import {
  renderConfiguredSummary,
  renderWizardView,
  type ConfiguredGroupSettings,
  type OnboardingView,
} from './group-onboarding.presenter.js';
import type { SignedStartToken } from './signed-start-token.js';

type BotMembershipStatus =
  'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

export interface OnboardingSnapshot {
  telegramChatId: TelegramId;
  onboardingState: 'PENDING' | 'CONFIGURING' | 'CONFIGURED';
  progress: Record<string, unknown>;
  settings: ConfiguredGroupSettings;
}

export interface OnboardingHandlerRepository {
  findByTelegramChatId(telegramChatId: TelegramId): Promise<Group | null>;
  setEnabled(groupId: GroupId, enabled: boolean): Promise<Group>;
  getOnboardingSnapshot(groupId: GroupId): Promise<OnboardingSnapshot | null>;
  saveWizardProgress(
    groupId: GroupId,
    progress: Record<string, unknown>,
  ): Promise<void>;
}

export interface OnboardingCallbackResult {
  notice?: string;
  showAlert?: boolean;
}

export class GroupOnboardingHandlers {
  constructor(
    private readonly onboard: OnboardGroup,
    private readonly configure: ConfigureGroup,
    private readonly authorization: Pick<
      AuthorizationService,
      'requireTelegramRole'
    >,
    private readonly groups: OnboardingHandlerRepository,
    private readonly signer: SignedStartToken,
    private readonly telegram: TelegramGateway,
  ) {}

  async handleMyChatMember(input: {
    telegramChatId: TelegramId;
    actorTelegramId: TelegramId;
    title: string;
    newStatus: BotMembershipStatus;
  }): Promise<void> {
    const existing = await this.groups.findByTelegramChatId(
      input.telegramChatId,
    );
    if (input.newStatus === 'left' || input.newStatus === 'kicked') {
      if (existing !== null) await this.groups.setEnabled(existing.id, false);
      return;
    }
    if (
      input.newStatus !== 'member' &&
      input.newStatus !== 'administrator' &&
      input.newStatus !== 'restricted'
    ) {
      return;
    }
    if (existing?.onboardingState === 'CONFIGURED') {
      await this.groups.setEnabled(existing.id, true);
      return;
    }

    const result = await this.onboard.execute({
      telegramChatId: input.telegramChatId,
      telegramUserId: input.actorTelegramId,
      title: input.title,
    });
    await this.telegram.sendMessage(
      input.telegramChatId,
      result.privateChatLink,
    );
  }

  async handleStart(input: {
    telegramUserId: TelegramId;
    privateChatId: TelegramId;
    token: string;
    now?: Date;
  }): Promise<boolean> {
    const payload = this.signer.verify(input.token, input.now);
    if (payload.purpose !== 'configure-group') return false;
    if (
      payload.administratorTelegramId !== input.telegramUserId ||
      input.privateChatId !== input.telegramUserId
    ) {
      throw new OnboardingInputError('FOREIGN_LINK');
    }
    const snapshot = await this.groups.getOnboardingSnapshot(payload.groupId);
    if (snapshot === null) throw new OnboardingInputError('INVALID_LINK');
    await this.assertAdministrator(
      payload.groupId,
      snapshot,
      input.telegramUserId,
    );
    await this.sendView(
      input.privateChatId,
      snapshot.onboardingState === 'CONFIGURED'
        ? renderConfiguredSummary(snapshot.settings)
        : renderWizardView(
            payload.groupId,
            parseWizardProgress(snapshot.progress),
          ),
    );
    return true;
  }

  async handleCallback(input: {
    telegramUserId: TelegramId;
    privateChatId: TelegramId;
    messageId?: bigint;
    data: string;
  }): Promise<OnboardingCallbackResult> {
    if (input.privateChatId !== input.telegramUserId) {
      throw new OnboardingInputError('FOREIGN_LINK');
    }
    const callback = parseOnboardingCallback(input.data);
    const snapshot = await this.groups.getOnboardingSnapshot(callback.groupId);
    if (snapshot === null) throw new OnboardingInputError('INVALID_CALLBACK');
    await this.assertAdministrator(
      callback.groupId,
      snapshot,
      input.telegramUserId,
    );
    const progress = parseWizardProgress(snapshot.progress);

    if (snapshot.onboardingState === 'CONFIGURED') {
      await this.editOrReplace(
        input.privateChatId,
        input.messageId,
        renderConfiguredSummary(snapshot.settings),
      );
      return { notice: 'Настройки уже сохранены' };
    }

    if (callback.kind === 'RESET') {
      await this.groups.saveWizardProgress(callback.groupId, {});
      await this.editOrReplace(
        input.privateChatId,
        input.messageId,
        renderWizardView(callback.groupId, {}),
      );
      return {};
    }

    if (callback.kind === 'SAVE') {
      if (nextWizardCode(progress) !== undefined) {
        await this.editOrReplace(
          input.privateChatId,
          input.messageId,
          renderWizardView(callback.groupId, progress),
        );
        return { notice: 'Сначала завершите все шаги', showAlert: true };
      }
      await this.configure.execute({
        groupId: callback.groupId,
        actorTelegramId: input.telegramUserId,
        ...toConfigureSettings(progress as CompleteWizardProgress),
      });
      const configured = await this.groups.getOnboardingSnapshot(
        callback.groupId,
      );
      if (configured === null) throw new Error('Configured group missing');
      await this.editOrReplace(
        input.privateChatId,
        input.messageId,
        renderConfiguredSummary(configured.settings),
      );
      return { notice: 'Настройки сохранены' };
    }

    if (nextWizardCode(progress) !== callback.answer.code) {
      await this.editOrReplace(
        input.privateChatId,
        input.messageId,
        renderWizardView(callback.groupId, progress),
      );
      return { notice: 'Показываю текущий шаг' };
    }
    const next = { ...progress, [callback.answer.code]: callback.answer.value };
    await this.groups.saveWizardProgress(callback.groupId, next);
    await this.editOrReplace(
      input.privateChatId,
      input.messageId,
      renderWizardView(callback.groupId, next),
    );
    return {};
  }

  private async assertAdministrator(
    groupId: GroupId,
    snapshot: OnboardingSnapshot,
    telegramUserId: TelegramId,
  ): Promise<void> {
    const current = await this.telegram.getChatMember(
      snapshot.telegramChatId,
      telegramUserId,
    );
    if (current.status !== 'creator' && current.status !== 'administrator') {
      throw new OnboardingInputError('ADMIN_REQUIRED');
    }
    await this.authorization.requireTelegramRole(
      groupId,
      telegramUserId,
      'ADMIN',
    );
  }

  private async sendView(
    chatId: TelegramId,
    view: OnboardingView,
  ): Promise<void> {
    await this.telegram.sendMessage(chatId, view.text, {
      parseMode: view.parseMode,
      keyboard: view.keyboard,
    });
  }

  private async editOrReplace(
    chatId: TelegramId,
    messageId: bigint | undefined,
    view: OnboardingView,
  ): Promise<void> {
    if (messageId === undefined || this.telegram.editMessage === undefined) {
      await this.sendView(chatId, view);
      return;
    }
    try {
      await this.telegram.editMessage(chatId, messageId, view.text, {
        parseMode: view.parseMode,
        keyboard: view.keyboard,
      });
    } catch (error) {
      if (!(error instanceof TelegramMessageNotEditableError)) throw error;
      await this.sendView(chatId, view);
    }
  }
}

const toConfigureSettings = (
  progress: CompleteWizardProgress,
): ConfiguredGroupSettings => ({
  timeZone: progress.tz,
  memberPriorityEnabled: progress.mp,
  tentativePromptMinutesBefore: progress.tp,
  tentativeResponseMinutes: progress.tr,
  reminderMinutesBefore: progress.rm,
  currency: 'RUB',
  roundingMode: progress.ro,
  pinGameMessages: progress.pin,
});

export const toTelegramId = (value: number): TelegramId =>
  asTelegramId(String(value));
