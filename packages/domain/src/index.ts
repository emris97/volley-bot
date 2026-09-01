export const packageMarker = 'domain' as const;
export type {
  Group,
  GroupMembership,
  GroupRole,
  MembershipStatus,
  OnboardingState,
} from './groups.js';
export {
  asGroupId,
  asTelegramId,
  asUserId,
  type GroupId,
  type TelegramId,
  type UserId,
} from './identity.js';
