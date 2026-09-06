import {
  asGroupId,
  asTelegramId,
  asUserId,
  type GroupId,
} from '@volley/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  OrganizerGroupSelectionRequiredError,
  ResolveOrganizerContext,
  type OrganizerDirectory,
  type StoredOrganizerGroup,
} from './resolve-organizer-context.js';

const telegramUserId = asTelegramId('100');
const firstGroupId = asGroupId('00000000-0000-4000-8000-000000000001');
const liveGroupId = asGroupId('00000000-0000-4000-8000-000000000002');
const userId = asUserId('00000000-0000-4000-8000-000000000003');

const storedGroup = (
  overrides: Partial<StoredOrganizerGroup> = {},
): StoredOrganizerGroup => ({
  groupId: firstGroupId,
  telegramChatId: asTelegramId('-1001000000001'),
  title: 'First volleyball group',
  timeZone: 'Europe/Astrakhan',
  enabled: true,
  onboardingState: 'CONFIGURED',
  userId,
  role: 'ADMIN',
  status: 'ACTIVE',
  ...overrides,
});

const directoryWith = (
  knownGroups: readonly StoredOrganizerGroup[],
  selectedGroupId: GroupId | null = null,
): OrganizerDirectory => ({
  listKnownGroups: vi.fn().mockResolvedValue(knownGroups),
  findKnownGroup: vi
    .fn()
    .mockImplementation(
      async (groupId: GroupId) =>
        knownGroups.find((group) => group.groupId === groupId) ?? null,
    ),
  refreshMembership: vi.fn().mockResolvedValue(userId),
  selectedGroup: vi.fn().mockResolvedValue(selectedGroupId),
  saveSelectedGroup: vi.fn().mockResolvedValue(undefined),
});

describe('ResolveOrganizerContext', () => {
  it('automatically requires the sole live configured organizer group', async () => {
    const directory = directoryWith([storedGroup()]);
    const telegram = {
      getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
    };
    const service = new ResolveOrganizerContext(telegram, directory);

    await expect(service.require(telegramUserId)).resolves.toEqual({
      groupId: firstGroupId,
      userId,
      telegramChatId: asTelegramId('-1001000000001'),
      title: 'First volleyball group',
      timeZone: 'Europe/Astrakhan',
    });
  });

  it('requires an explicit selection when multiple live organizer groups exist', async () => {
    const directory = directoryWith([
      storedGroup(),
      storedGroup({
        groupId: liveGroupId,
        telegramChatId: asTelegramId('-1001000000002'),
        title: 'Second volleyball group',
      }),
    ]);
    const service = new ResolveOrganizerContext(
      {
        getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
      },
      directory,
    );

    await expect(service.require(telegramUserId)).rejects.toBeInstanceOf(
      OrganizerGroupSelectionRequiredError,
    );
  });

  it('preserves a valid stored selection among multiple organizer groups', async () => {
    const directory = directoryWith(
      [
        storedGroup(),
        storedGroup({
          groupId: liveGroupId,
          telegramChatId: asTelegramId('-1001000000002'),
          title: 'Selected volleyball group',
        }),
      ],
      liveGroupId,
    );
    const service = new ResolveOrganizerContext(
      { getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }) },
      directory,
    );

    await expect(service.list(telegramUserId)).resolves.toEqual([
      expect.objectContaining({ groupId: firstGroupId, selected: false }),
      expect.objectContaining({ groupId: liveGroupId, selected: true }),
    ]);
    await expect(service.require(telegramUserId)).resolves.toMatchObject({
      groupId: liveGroupId,
      userId,
    });
  });

  it('drops a stale stored admin and keeps a live Telegram administrator', async () => {
    const directory = directoryWith([
      storedGroup(),
      storedGroup({
        groupId: liveGroupId,
        telegramChatId: asTelegramId('-1001000000002'),
        title: 'Live volleyball group',
      }),
    ]);
    const service = new ResolveOrganizerContext(
      {
        getChatMember: vi
          .fn()
          .mockResolvedValueOnce({ status: 'member' })
          .mockResolvedValueOnce({ status: 'administrator' }),
      },
      directory,
    );

    const result = await service.list(telegramUserId);

    expect(result.map((group) => group.groupId)).toEqual([liveGroupId]);
    expect(directory.refreshMembership).toHaveBeenCalledWith({
      groupId: liveGroupId,
      telegramUserId,
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(directory.refreshMembership).toHaveBeenCalledWith({
      groupId: firstGroupId,
      telegramUserId,
      role: 'MEMBER',
      status: 'ACTIVE',
    });
  });

  it.each(['member', 'restricted'] as const)(
    'keeps a Telegram %s as an active non-admin member',
    async (status) => {
      const directory = directoryWith([storedGroup()]);
      const service = new ResolveOrganizerContext(
        { getChatMember: vi.fn().mockResolvedValue({ status }) },
        directory,
      );

      await expect(service.list(telegramUserId)).resolves.toEqual([]);
      expect(directory.refreshMembership).toHaveBeenCalledWith({
        groupId: firstGroupId,
        telegramUserId,
        role: 'MEMBER',
        status: 'ACTIVE',
      });
    },
  );

  it.each(['left', 'kicked'] as const)(
    'records Telegram %s as a departed member',
    async (status) => {
      const directory = directoryWith([storedGroup()]);
      const service = new ResolveOrganizerContext(
        { getChatMember: vi.fn().mockResolvedValue({ status }) },
        directory,
      );

      await expect(service.list(telegramUserId)).resolves.toEqual([]);
      expect(directory.refreshMembership).toHaveBeenCalledWith({
        groupId: firstGroupId,
        telegramUserId,
        role: 'MEMBER',
        status: 'LEFT',
      });
    },
  );

  it('maps a Telegram creator to OWNER when selecting a group', async () => {
    const directory = directoryWith([storedGroup()]);
    const service = new ResolveOrganizerContext(
      {
        getChatMember: vi.fn().mockResolvedValue({ status: 'creator' }),
      },
      directory,
    );

    await expect(
      service.select(telegramUserId, firstGroupId),
    ).resolves.toMatchObject({
      groupId: firstGroupId,
      userId,
    });
    expect(directory.refreshMembership).toHaveBeenCalledWith({
      groupId: firstGroupId,
      telegramUserId,
      role: 'OWNER',
      status: 'ACTIVE',
    });
    expect(directory.saveSelectedGroup).toHaveBeenCalledWith(
      telegramUserId,
      firstGroupId,
    );
  });

  it.each([
    ['unconfigured', { onboardingState: 'CONFIGURING' as const }],
    ['disabled', { enabled: false }],
  ])(
    'rejects selecting a live administrator group that is %s',
    async (_, state) => {
      const directory = directoryWith([storedGroup(state)]);
      const service = new ResolveOrganizerContext(
        {
          getChatMember: vi.fn().mockResolvedValue({ status: 'administrator' }),
        },
        directory,
      );

      await expect(
        service.select(telegramUserId, firstGroupId),
      ).rejects.toBeInstanceOf(OrganizerGroupSelectionRequiredError);
      expect(directory.saveSelectedGroup).not.toHaveBeenCalled();
    },
  );
});
