import type {
  Game,
  GameId,
  GameState,
  GroupId,
  RegistrationCandidate,
} from '@volley/domain';

export type ScheduledJobKind =
  | 'OPEN_REGISTRATION'
  | 'CLOSE_REGISTRATION'
  | 'REQUEST_TENTATIVE_CONFIRMATION'
  | 'EXPIRE_TENTATIVE'
  | 'REMIND_PARTICIPANTS';

export interface RequiredJob {
  id: string;
  kind: ScheduledJobKind;
  groupId: GroupId;
  gameId: GameId;
  scheduleRevision: number;
  runAt: Date;
  expectedState?: GameState;
  targetState?: GameState;
}

export const requiredJobsForGame = (
  game: Game,
  registrations: readonly RegistrationCandidate[],
): RequiredJob[] => {
  if (
    game.id === undefined ||
    game.groupId === undefined ||
    ['DRAFT', 'COMPLETED', 'CANCELLED'].includes(game.state)
  ) {
    return [];
  }

  const jobs: RequiredJob[] = [];
  const add = (
    kind: ScheduledJobKind,
    runAt: Date,
    transition?: { expectedState: GameState; targetState: GameState },
  ): void => {
    jobs.push({
      id: `${kind}:${game.id}:${game.scheduleRevision}`,
      kind,
      groupId: game.groupId!,
      gameId: game.id!,
      scheduleRevision: game.scheduleRevision,
      runAt: new Date(runAt),
      ...transition,
    });
  };

  if (game.state === 'SCHEDULED') {
    add('OPEN_REGISTRATION', game.registrationOpensAt, {
      expectedState: 'SCHEDULED',
      targetState: 'OPEN',
    });
  }
  if (
    (game.state === 'SCHEDULED' || game.state === 'OPEN') &&
    game.registrationClosesAt !== null
  ) {
    add('CLOSE_REGISTRATION', game.registrationClosesAt, {
      expectedState: 'OPEN',
      targetState: 'CLOSED',
    });
  }
  if (registrations.some((item) => item.state === 'TENTATIVE')) {
    add('REQUEST_TENTATIVE_CONFIRMATION', game.tentativePromptAt);
    add('EXPIRE_TENTATIVE', game.tentativeResponseDeadline);
  }
  if (registrations.some((item) => item.state === 'ROSTERED')) {
    add('REMIND_PARTICIPANTS', game.reminderAt);
  }
  return jobs;
};
