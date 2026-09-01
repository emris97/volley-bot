import type { GroupId, TelegramId, UserId } from './identity.js';

export type GroupRole = 'OWNER' | 'ADMIN' | 'ORGANIZER' | 'MEMBER';
export type MembershipStatus = 'ACTIVE' | 'LEFT' | 'BANNED';
export type OnboardingState = 'PENDING' | 'CONFIGURING' | 'CONFIGURED';

export interface Group {
  id: GroupId;
  telegramChatId: TelegramId;
  title: string;
  timeZone: string;
  enabled: boolean;
  onboardingState: OnboardingState;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupMembership {
  groupId: GroupId;
  userId: UserId;
  telegramUserId: TelegramId;
  role: GroupRole;
  membershipStatus: MembershipStatus;
  checkedAt: Date;
}
