export const packageMarker = 'persistence' as const;
export { createDatabase, type Database } from './client.js';
export {
  GroupRepository,
  type UpsertGroupFromTelegramInput,
} from './repositories/group.repository.js';
export { GameRepository } from './repositories/game.repository.js';
export { AttendanceRepository } from './repositories/attendance.repository.js';
export {
  PaymentRepository,
  type StoredPaymentDraft,
  type StoredSettlement,
  type StoredSettlementCharge,
} from './repositories/payment.repository.js';
export {
  GameMessageRepository,
  type StoredGameMessageView,
} from './repositories/game-message.repository.js';
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
export {
  NotificationRepository,
  type NotificationRecipientRecord,
} from './repositories/notification.repository.js';
export { ScheduledJobRepository } from './repositories/scheduled-job.repository.js';
export * from './schema/index.js';
