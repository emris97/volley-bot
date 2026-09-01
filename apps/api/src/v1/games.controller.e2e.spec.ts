import { createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  AuthorizationService,
  type AuthorizationRepository,
} from '@volley/application';
import {
  asGameId,
  asGroupId,
  asTelegramId,
  asUserId,
  type Game,
  type GroupId,
  type UserId,
} from '@volley/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_PRINCIPAL_RESOLVER,
  MINI_APP_INIT_DATA_VERIFIER,
  MiniAppAuthGuard,
  type AuthenticatedPrincipalResolver,
} from '../auth/auth.guard.js';
import { MiniAppInitDataVerifier } from '../auth/mini-app-init-data.verifier.js';
import {
  GAME_QUERIES,
  GamesController,
  type GameQueries,
} from './games.controller.js';

const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const NOW_SECONDS = Math.floor(Date.now() / 1_000);
const TELEGRAM_USER_ID = asTelegramId('900719925474099');
const INTERNAL_USER_ID = asUserId('10000000-0000-4000-8000-000000000001');
const GROUP_A = asGroupId('20000000-0000-4000-8000-000000000001');
const GROUP_B = asGroupId('20000000-0000-4000-8000-000000000002');
const GROUP_C = asGroupId('20000000-0000-4000-8000-000000000003');
const GAME_A = asGameId('30000000-0000-4000-8000-000000000001');
const MISSING_GAME = asGameId('30000000-0000-4000-8000-000000000099');

const gameInGroupA: Game = {
  id: GAME_A,
  groupId: GROUP_A,
  sourceTemplateId: null,
  name: 'Tuesday volleyball',
  venue: 'Central hall',
  address: null,
  startsAt: new Date('2026-09-01T16:00:00.000Z'),
  durationMinutes: 120,
  capacity: 18,
  timeZone: 'Europe/Astrakhan',
  registrationOpensAt: new Date('2026-08-25T16:00:00.000Z'),
  registrationClosesAt: null,
  tentativePromptAt: new Date('2026-08-31T16:00:00.000Z'),
  tentativeResponseDeadline: new Date('2026-09-01T12:00:00.000Z'),
  reminderAt: new Date('2026-09-01T14:00:00.000Z'),
  memberPriorityEnabled: true,
  totalCostMinor: 280_000n,
  currency: 'RUB',
  roundingMode: 'EXACT',
  state: 'OPEN',
  scheduleRevision: 4,
  canonicalTelegramMessageId: 123n,
};

const signAuthorization = (telegramUserId = TELEGRAM_USER_ID): string => {
  const entries = [
    ['auth_date', String(NOW_SECONDS)],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    [
      'user',
      JSON.stringify({
        id: Number(telegramUserId),
        first_name: 'Ada',
        username: 'ada_volley',
      }),
    ],
  ] as const;
  const check = entries
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const raw = [...entries, ['hash', hash] as const]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  return `tma ${raw}`;
};

describe('GET /api/v1/groups/:groupId/games/:gameId', () => {
  let app: NestFastifyApplication | undefined;
  let memberships: Map<string, { role: 'MEMBER'; membershipStatus: 'ACTIVE' }>;

  beforeEach(async () => {
    memberships = new Map([
      [
        `${GROUP_A}:${INTERNAL_USER_ID}`,
        { role: 'MEMBER', membershipStatus: 'ACTIVE' },
      ],
      [
        `${GROUP_B}:${INTERNAL_USER_ID}`,
        { role: 'MEMBER', membershipStatus: 'ACTIVE' },
      ],
    ]);
    const principals: AuthenticatedPrincipalResolver = {
      resolve: async (telegramUserId) =>
        telegramUserId === TELEGRAM_USER_ID ? INTERNAL_USER_ID : null,
    };
    const authorizationRepository: AuthorizationRepository = {
      findMembership: async (groupId: GroupId, userId: UserId) =>
        memberships.get(`${groupId}:${userId}`) ?? null,
    };
    const queries: GameQueries = {
      getGame: async (groupId, gameId) =>
        gameInGroupA.groupId === groupId && gameInGroupA.id === gameId
          ? gameInGroupA
          : null,
    };
    const module = await Test.createTestingModule({
      controllers: [GamesController],
      providers: [
        MiniAppAuthGuard,
        {
          provide: MINI_APP_INIT_DATA_VERIFIER,
          useValue: new MiniAppInitDataVerifier(BOT_TOKEN),
        },
        { provide: AUTHENTICATED_PRINCIPAL_RESOLVER, useValue: principals },
        {
          provide: AuthorizationService,
          useValue: new AuthorizationService(authorizationRepository),
        },
        { provide: GAME_QUERIES, useValue: queries },
      ],
    }).compile();

    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('maps signed Telegram identity to the internal principal and returns a tenant-scoped game', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_A}/games/${GAME_A}`,
      headers: { authorization: signAuthorization() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: GAME_A,
      groupId: GROUP_A,
      name: 'Tuesday volleyball',
      venue: 'Central hall',
      address: null,
      startsAt: '2026-09-01T16:00:00.000Z',
      durationMinutes: 120,
      capacity: 18,
      timeZone: 'Europe/Astrakhan',
      registrationOpensAt: '2026-08-25T16:00:00.000Z',
      registrationClosesAt: null,
      memberPriorityEnabled: true,
      totalCostMinor: '280000',
      currency: 'RUB',
      roundingMode: 'EXACT',
      state: 'OPEN',
      scheduleRevision: 4,
    });
  });

  it('rejects a signed Telegram identity with no internal user mapping', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_A}/games/${GAME_A}`,
      headers: { authorization: signAuthorization(asTelegramId('42')) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('requires active group membership through shared authorization', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_C}/games/${GAME_A}`,
      headers: { authorization: signAuthorization() },
    });

    expect(response.statusCode).toBe(403);
  });

  it('never accepts initDataUnsafe as authentication', async () => {
    const response = await app!.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_A}/games/${GAME_A}`,
      headers: {
        'x-telegram-init-data-unsafe': JSON.stringify({
          auth_date: NOW_SECONDS,
          user: { id: Number(TELEGRAM_USER_ID) },
        }),
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('does not return a game belonging to another group or reveal its existence', async () => {
    const [foreignResponse, missingResponse] = await Promise.all([
      app!.inject({
        method: 'GET',
        url: `/api/v1/groups/${GROUP_B}/games/${GAME_A}`,
        headers: { authorization: signAuthorization() },
      }),
      app!.inject({
        method: 'GET',
        url: `/api/v1/groups/${GROUP_B}/games/${MISSING_GAME}`,
        headers: { authorization: signAuthorization() },
      }),
    ]);

    expect(foreignResponse.statusCode).toBe(404);
    expect(foreignResponse.json()).toEqual(missingResponse.json());
  });
});
