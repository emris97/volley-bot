import {
  asGameTemplateId,
  asGroupId,
  asUserId,
  type GameTemplate,
  type GameTemplateId,
  type GameTemplateSnapshot,
  type GroupId,
} from '@volley/domain';
import { describe, expect, it } from 'vitest';
import {
  TemplateNotFoundError,
  TemplateRevisionConflictError,
} from './template-errors.js';
import { ListTemplates } from './list-templates.js';
import type { GameAuthorization, TemplateRepository } from './ports.js';
import { SetTemplateArchived } from './set-template-archived.js';
import { UpdateTemplate } from './update-template.js';

const groupId = asGroupId('10000000-0000-4000-8000-000000000001');
const anotherGroupId = asGroupId('10000000-0000-4000-8000-000000000002');
const actorUserId = asUserId('20000000-0000-4000-8000-000000000001');
const templateId = asGameTemplateId('30000000-0000-4000-8000-000000000001');

const snapshot: GameTemplateSnapshot = {
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAtLocalTime: '19:30',
  durationMinutes: 120,
  capacity: 12,
  registrationOpensMinutesBefore: 10_080,
  registrationClosesMinutesBefore: 60,
  tentativePromptMinutesBefore: 1_440,
  tentativeResponseMinutes: 60,
  reminderMinutesBefore: 120,
  memberPriorityEnabled: true,
  defaultTotalCostMinor: null,
  currency: 'RUB',
  roundingMode: 'EXACT',
};

const template = (overrides: Partial<GameTemplate> = {}): GameTemplate => ({
  id: templateId,
  groupId,
  ...snapshot,
  revision: 2,
  archivedAt: null,
  createdAt: new Date('2026-09-06T00:00:00.000Z'),
  updatedAt: new Date('2026-09-06T00:00:00.000Z'),
  ...overrides,
});

const authorization: GameAuthorization = {
  requireOrganizer: async () => undefined,
};

describe('template management use cases', () => {
  it('rejects a stale update revision after loading the tenant-scoped template', async () => {
    const repository = repositoryWith({ update: async () => null });
    const update = new UpdateTemplate(authorization, repository);

    await expect(
      update.execute({
        groupId,
        actorUserId,
        templateId,
        expectedRevision: 2,
        snapshot,
      }),
    ).rejects.toThrow(TemplateRevisionConflictError);
  });

  it('rejects a template ID belonging to another group', async () => {
    const repository = repositoryWith({ findById: async () => null });
    const update = new UpdateTemplate(authorization, repository);

    await expect(
      update.execute({
        groupId: anotherGroupId,
        actorUserId,
        templateId,
        expectedRevision: 2,
        snapshot,
      }),
    ).rejects.toThrow(TemplateNotFoundError);
  });

  it('archives with optimistic revision and excludes archived templates from active lists', async () => {
    const archived = template({
      archivedAt: new Date('2026-09-06T01:00:00.000Z'),
    });
    let active = [template()];
    const repository = repositoryWith({
      setArchived: async ({ archived: shouldArchive }) => {
        active = shouldArchive ? [] : [template()];
        return shouldArchive ? archived : template();
      },
      list: async (_groupId, { archived: includeArchived }) => ({
        items: includeArchived ? [archived] : active,
        nextCursor: null,
      }),
    });
    const archive = new SetTemplateArchived(authorization, repository);
    const list = new ListTemplates(repository);

    await archive.execute({
      groupId,
      actorUserId,
      templateId,
      expectedRevision: 2,
      archived: true,
    });

    await expect(list.execute({ groupId, limit: 8 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('restores with optimistic revision', async () => {
    const repository = repositoryWith({
      findById: async () =>
        template({ archivedAt: new Date('2026-09-06T01:00:00.000Z') }),
      setArchived: async ({ archived }) =>
        template({ archivedAt: archived ? new Date() : null }),
    });
    const restore = new SetTemplateArchived(authorization, repository);

    await expect(
      restore.execute({
        groupId,
        actorUserId,
        templateId,
        expectedRevision: 2,
        archived: false,
      }),
    ).resolves.toMatchObject({ archivedAt: null });
  });
});

const repositoryWith = (
  overrides: Partial<TemplateRepository>,
): TemplateRepository => ({
  findById: async (_groupId: GroupId, requestedTemplateId: GameTemplateId) =>
    requestedTemplateId === templateId ? template() : null,
  insert: async () => template(),
  list: async () => ({ items: [], nextCursor: null }),
  update: async () => template(),
  setArchived: async () => template(),
  ...overrides,
});
