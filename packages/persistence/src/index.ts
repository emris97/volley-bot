export const packageMarker = 'persistence' as const;
export { createDatabase, type Database } from './client.js';
export {
  GroupRepository,
  type UpsertGroupFromTelegramInput,
} from './repositories/group.repository.js';
export { GameRepository } from './repositories/game.repository.js';
export {
  GameCreationDraftRepository,
  type StoredGameCreationDraft,
} from './repositories/game-creation-draft.repository.js';
export { TemplateRepository } from './repositories/template.repository.js';
export {
  GuestRegistrationDraftRepository,
  type StoredGuestRegistrationDraft,
} from './repositories/guest-registration-draft.repository.js';
export {
  RegistrationRepository,
  type RegisterGuestInput,
  type RegisterParticipantInput,
  type RegistrationResult,
} from './repositories/registration.repository.js';
export { OutboxRepository } from './repositories/outbox.repository.js';
export * from './schema/index.js';
