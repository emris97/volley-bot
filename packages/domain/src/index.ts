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
export {
  asGameId,
  type Game,
  type GameId,
  type GameState,
} from './games/game.js';
export {
  asGameTemplateId,
  type Currency,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type RoundingMode,
} from './games/game-template.js';
export {
  createGameFromTemplate,
  transitionGame,
} from './games/game-policy.js';
export {
  InvalidRegistrationError,
  RegistrationMutationNotAllowedError,
} from './registrations/registration-errors.js';
export {
  asRegistrationId,
  type Registration,
  type RegistrationCandidate,
  type RegistrationId,
  type RegistrationKind,
  type RegistrationState,
} from './registrations/registration.js';
export {
  placeConfirmedRegistrations,
  rankConfirmedRegistrations,
  type PlacementInput,
  type PlacementResult,
} from './registrations/placement-policy.js';
export {
  type AttendanceEntry,
  type AttendanceSnapshot,
} from './attendance/attendance.js';
