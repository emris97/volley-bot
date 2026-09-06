import {
  asGameId,
  asGameTemplateId,
  asGroupId,
  asUserId,
  type Game,
  type GameTemplateSnapshot,
} from '@volley/domain';
import { describe, expect, it } from 'vitest';
import type { GameCreationDraft } from './game-creation-draft.js';
import type { GamePublicationRepository } from './ports.js';
import { PublishGame } from './publish-game.js';

const groupId = asGroupId('10000000-0000-4000-8000-000000000001');
const actorUserId = asUserId('20000000-0000-4000-8000-000000000001');
const templateId = asGameTemplateId('30000000-0000-4000-8000-000000000001');
const gameId = asGameId('40000000-0000-4000-8000-000000000001');
const draftId = '018f6ba062d27bd18f1312e0c8424611';
const now = new Date('2026-09-05T15:00:00.000Z');

const snapshot: GameTemplateSnapshot = {
  name: 'Friday volleyball',
  venue: 'Arena',
  address: null,
  startsAtLocalTime: '20:00',
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

const previewedDraft = (
  overrides: Partial<GameCreationDraft> = {},
): GameCreationDraft => ({
  version: 1,
  draftId,
  groupId,
  actorUserId,
  step: 'PREVIEW',
  templateId,
  snapshot: { ...snapshot },
  startsAtIso: '2026-09-12T16:00:00.000Z',
  previewed: true,
  ...overrides,
});

class InMemoryPublicationRepository implements GamePublicationRepository {
  private game: Game | null = null;

  public constructor(public draft: GameCreationDraft) {}

  public async publishDraft(
    input: {
      groupId: typeof groupId;
      actorUserId: typeof actorUserId;
      draftId: string;
      expectedStep: GameCreationDraft['step'];
      expectedViewRevision: number;
      now: Date;
    },
    build: (draft: GameCreationDraft) => Game,
  ): Promise<{ game: Game; created: boolean }> {
    if (
      input.groupId !== this.draft.groupId ||
      input.actorUserId !== this.draft.actorUserId ||
      input.draftId !== this.draft.draftId ||
      (input.expectedStep !== this.draft.step &&
        !(
          this.draft.step === 'PUBLISHED' && input.expectedStep === 'PREVIEW'
        )) ||
      input.expectedViewRevision !== (this.draft.viewRevision ?? 0) ||
      this.draft.cancelPending === true
    ) {
      throw new Error('Game creation draft is stale');
    }
    if (this.draft.publishedGameId !== undefined) {
      if (this.game === null) throw new Error('Published game not found');
      return { game: this.game, created: false };
    }
    const built = build(structuredClone(this.draft));
    this.game = { ...built, id: gameId };
    this.draft = {
      ...this.draft,
      step: 'PUBLISHED',
      publishedGameId: gameId,
    };
    return { game: this.game, created: true };
  }
}

const useCase = (draft = previewedDraft()) => {
  const repository = new InMemoryPublicationRepository(draft);
  const publish = new PublishGame(
    { requireOrganizer: async () => undefined },
    { findTimeZone: async () => 'Europe/Astrakhan' },
    repository,
  );
  return { publish, repository };
};

const command = (
  overrides: {
    draftId?: string;
    expectedStep?: GameCreationDraft['step'];
    now?: Date;
  } = {},
) => ({
  groupId,
  actorUserId,
  draftId: overrides.draftId ?? draftId,
  expectedStep: overrides.expectedStep ?? ('PREVIEW' as const),
  expectedViewRevision: 0,
  now: overrides.now ?? now,
});

describe('PublishGame', () => {
  it('rejects a draft that has not been previewed', async () => {
    const { publish } = useCase(
      previewedDraft({ step: 'CUSTOMIZE', previewed: false }),
    );

    await expect(
      publish.execute(command({ expectedStep: 'CUSTOMIZE' })),
    ).rejects.toThrow(/preview/i);
  });

  it('rejects a stale draft id', async () => {
    const { publish } = useCase();

    await expect(
      publish.execute(command({ draftId: 'ffffffffffffffffffffffffffffffff' })),
    ).rejects.toThrow(/stale/i);
  });

  it('rejects a changed or cancel-pending rendered view', async () => {
    const changed = useCase(previewedDraft({ viewRevision: 1 }));
    const cancelling = useCase(previewedDraft({ cancelPending: true }));

    await expect(changed.publish.execute(command())).rejects.toThrow(/stale/i);
    await expect(cancelling.publish.execute(command())).rejects.toThrow(
      /stale/i,
    );
  });

  it('rejects a start at or before publication time', async () => {
    const { publish } = useCase(
      previewedDraft({ startsAtIso: now.toISOString() }),
    );

    await expect(publish.execute(command())).rejects.toThrow(/future/i);
  });

  it('rejects an elapsed configured registration-close time', async () => {
    const { publish } = useCase(
      previewedDraft({
        snapshot: {
          ...snapshot,
          registrationOpensMinutesBefore: 20_160,
          registrationClosesMinutesBefore: 10_080,
        },
        startsAtIso: '2026-09-12T15:00:00.000Z',
      }),
    );

    await expect(publish.execute(command())).rejects.toThrow(/closing/i);
  });

  it('publishes as scheduled while registration opening is in the future', async () => {
    const { publish } = useCase();

    const result = await publish.execute(command());

    expect(result.created).toBe(true);
    expect(result.game).toMatchObject({
      id: gameId,
      groupId,
      sourceTemplateId: templateId,
      name: snapshot.name,
      state: 'SCHEDULED',
      revision: 0,
    });
  });

  it('publishes as open when registration opening is due', async () => {
    const { publish } = useCase();

    const result = await publish.execute(
      command({ now: new Date('2026-09-05T16:00:00.000Z') }),
    );

    expect(result.game.state).toBe('OPEN');
  });

  it('returns one game for repeat and concurrent publication calls', async () => {
    const { publish } = useCase();
    const input = command();

    const [first, second] = await Promise.all([
      publish.execute(input),
      publish.execute(input),
    ]);

    expect(new Set([first.game.id, second.game.id]).size).toBe(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    await expect(publish.execute(input)).resolves.toMatchObject({
      game: { id: gameId },
      created: false,
    });
  });
});
