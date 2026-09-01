export const packageMarker = 'persistence' as const;
export { createDatabase, type Database } from './client.js';
export {
  GroupRepository,
  type UpsertGroupFromTelegramInput,
} from './repositories/group.repository.js';
export { GameRepository } from './repositories/game.repository.js';
export { TemplateRepository } from './repositories/template.repository.js';
export * from './schema/index.js';
