export const packageMarker = 'persistence' as const;
export { createDatabase, type Database } from './client.js';
export {
  GroupRepository,
  type UpsertGroupFromTelegramInput,
} from './repositories/group.repository.js';
export * from './schema/index.js';
