import type { Game, GameState } from './game.js';
import type { GameTemplateSnapshot } from './game-template.js';

const allowedTransitions: Record<GameState, readonly GameState[]> = {
  DRAFT: ['SCHEDULED', 'OPEN', 'CANCELLED'],
  SCHEDULED: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED', 'CANCELLED'],
  CLOSED: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const transitionGame = (
  current: GameState,
  target: GameState,
): GameState => {
  if (!allowedTransitions[current].includes(target)) {
    throw new Error(`Invalid game transition: ${current} -> ${target}`);
  }
  return target;
};

const minutesBefore = (startsAt: Date, minutes: number): Date =>
  new Date(startsAt.getTime() - minutes * 60_000);

export const createGameFromTemplate = (
  template: GameTemplateSnapshot,
  startsAt: Date,
  timeZone: string,
): Game => {
  const tentativePromptAt = minutesBefore(
    startsAt,
    template.tentativePromptMinutesBefore,
  );

  return {
    name: template.name,
    venue: template.venue,
    address: template.address,
    startsAt: new Date(startsAt),
    durationMinutes: template.durationMinutes,
    capacity: template.capacity,
    timeZone,
    registrationOpensAt: minutesBefore(
      startsAt,
      template.registrationOpensMinutesBefore,
    ),
    registrationClosesAt:
      template.registrationClosesMinutesBefore === null
        ? null
        : minutesBefore(startsAt, template.registrationClosesMinutesBefore),
    tentativePromptAt,
    tentativeResponseDeadline: new Date(
      tentativePromptAt.getTime() + template.tentativeResponseMinutes * 60_000,
    ),
    reminderAt: minutesBefore(startsAt, template.reminderMinutesBefore),
    memberPriorityEnabled: template.memberPriorityEnabled,
    totalCostMinor: template.defaultTotalCostMinor,
    currency: template.currency,
    roundingMode: template.roundingMode,
    state: 'DRAFT',
    scheduleRevision: 0,
    canonicalTelegramMessageId: null,
  };
};
