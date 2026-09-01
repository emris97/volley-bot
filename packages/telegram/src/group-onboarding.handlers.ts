import type {
  ConfigureGroup,
  OnboardGroup,
  TelegramGateway,
} from '@volley/application';
import {
  asGroupId,
  asTelegramId,
  type Group,
  type GroupId,
  type TelegramId,
} from '@volley/domain';
import type { SignedStartToken } from './signed-start-token.js';

type BotMembershipStatus =
  'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

type WizardCode = 'tz' | 'mp' | 'tp' | 'tr' | 'rm' | 'ro' | 'pin';
type WizardProgress = Partial<{
  tz: string;
  mp: boolean;
  tp: number;
  tr: number;
  rm: number;
  ro: 'EXACT' | 'UP_1' | 'UP_10' | 'UP_50';
  pin: boolean;
}>;

const wizardOrder: readonly WizardCode[] = [
  'tz',
  'mp',
  'tp',
  'tr',
  'rm',
  'ro',
  'pin',
];

export interface OnboardingHandlerRepository {
  findByTelegramChatId(telegramChatId: TelegramId): Promise<Group | null>;
  setEnabled(groupId: GroupId, enabled: boolean): Promise<Group>;
  findMembership(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<{ role: string; membershipStatus: string } | null>;
  getWizardProgress(groupId: GroupId): Promise<Record<string, unknown>>;
  saveWizardProgress(
    groupId: GroupId,
    progress: Record<string, unknown>,
  ): Promise<void>;
}

export class GroupOnboardingHandlers {
  constructor(
    private readonly onboard: OnboardGroup,
    private readonly configure: ConfigureGroup,
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
    if (existing !== null) {
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
    if (payload.purpose !== 'configure-group') {
      return false;
    }
    if (payload.administratorTelegramId !== input.telegramUserId) {
      throw new Error('Start token belongs to another administrator');
    }
    await this.assertAdministrator(payload.groupId, input.telegramUserId);
    const progress = await this.groups.getWizardProgress(payload.groupId);
    await this.sendNextPrompt(input.privateChatId, progress as WizardProgress);
    return true;
  }

  async handleCallback(input: {
    telegramUserId: TelegramId;
    privateChatId: TelegramId;
    data: string;
  }): Promise<void> {
    const parsed = parseCallback(input.data);
    await this.assertAdministrator(parsed.groupId, input.telegramUserId);
    const progress = (await this.groups.getWizardProgress(
      parsed.groupId,
    )) as WizardProgress;
    const expected = nextCode(progress);
    if (expected !== parsed.code) {
      throw new Error(
        `Unexpected wizard field; expected ${expected ?? 'complete'}`,
      );
    }
    const next = {
      ...progress,
      [parsed.code]: parseValue(parsed.code, parsed.value),
    };
    await this.groups.saveWizardProgress(parsed.groupId, next);

    if (nextCode(next) !== undefined) {
      await this.sendNextPrompt(input.privateChatId, next);
      return;
    }

    await this.configure.execute({
      groupId: parsed.groupId,
      actorTelegramId: input.telegramUserId,
      timeZone: next.tz!,
      memberPriorityEnabled: next.mp!,
      tentativePromptMinutesBefore: next.tp!,
      tentativeResponseMinutes: next.tr!,
      reminderMinutesBefore: next.rm!,
      currency: 'RUB',
      roundingMode: next.ro!,
      pinGameMessages: next.pin!,
    });
    await this.telegram.sendMessage(input.privateChatId, 'onboarding:complete');
  }

  private async assertAdministrator(
    groupId: GroupId,
    telegramUserId: TelegramId,
  ): Promise<void> {
    const member = await this.groups.findMembership(groupId, telegramUserId);
    if (
      member?.membershipStatus !== 'ACTIVE' ||
      (member.role !== 'OWNER' && member.role !== 'ADMIN')
    ) {
      throw new Error('Only an owner or admin may configure a group');
    }
  }

  private async sendNextPrompt(
    chatId: TelegramId,
    progress: WizardProgress,
  ): Promise<void> {
    const code = nextCode(progress);
    await this.telegram.sendMessage(
      chatId,
      code === undefined ? 'onboarding:complete' : `onboarding:${code}`,
    );
  }
}

const nextCode = (progress: WizardProgress): WizardCode | undefined =>
  wizardOrder.find((code) => progress[code] === undefined);

const parseCallback = (
  data: string,
): { groupId: GroupId; code: WizardCode; value: string } => {
  const [prefix, rawGroupId, rawCode, ...valueParts] = data.split(':');
  if (
    prefix !== 'cfg' ||
    rawGroupId === undefined ||
    !wizardOrder.includes(rawCode as WizardCode) ||
    valueParts.length === 0
  ) {
    throw new Error('Invalid onboarding callback');
  }
  return {
    groupId: asGroupId(rawGroupId),
    code: rawCode as WizardCode,
    value: valueParts.join(':'),
  };
};

const parseValue = (
  code: WizardCode,
  value: string,
): string | number | boolean => {
  if (code === 'tz') {
    if (value.length === 0) throw new Error('Time zone is required');
    return value;
  }
  if (code === 'mp' || code === 'pin') {
    if (value !== '0' && value !== '1') throw new Error('Invalid boolean');
    return value === '1';
  }
  if (code === 'ro') {
    if (!['EXACT', 'UP_1', 'UP_10', 'UP_50'].includes(value)) {
      throw new Error('Invalid rounding mode');
    }
    return value;
  }
  if (!/^\d+$/.test(value)) throw new Error('Invalid duration');
  const duration = Number(value);
  if (!Number.isSafeInteger(duration)) throw new Error('Invalid duration');
  return duration;
};

export const toTelegramId = (value: number): TelegramId =>
  asTelegramId(String(value));
