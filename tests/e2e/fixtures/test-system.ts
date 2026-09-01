import { randomUUID } from 'node:crypto';
import { NotificationSender, tentativeCallback } from '@volley/telegram';
import {
  ReconcileGameJobs,
  requiredJobsForGame,
  type DelayedJobScheduler,
  type NotificationIntent,
  type RequiredJob,
  type ScheduledJobStore,
  type StoredScheduledJob,
} from '@volley/application';
import {
  asGameId,
  asGroupId,
  asRegistrationId,
  asTelegramId,
  type Game,
  type GameId,
  type RegistrationCandidate,
  type TelegramId,
} from '@volley/domain';
import { TestClock } from './test-clock.js';
import { FakeTelegramGateway } from './telegram-gateway.fake.js';

export class TestSystem {
  public readonly clock = new TestClock();
  public readonly telegram = new FakeTelegramGateway();
  private readonly postgresJobs = new InMemoryScheduledJobStore();
  private readonly redis = new InMemoryDelayedJobScheduler();
  private readonly reconciler = new ReconcileGameJobs(
    this.postgresJobs,
    this.redis,
  );
  private readonly sender = new NotificationSender(this.telegram, {
    markUnavailable: async () => undefined,
  });
  private game?: Game;
  private registrations: RegistrationCandidate[] = [];
  private readonly telegramIds = new Map<string, TelegramId>();
  private readonly completed = new Set<string>();

  public async createScheduledGame(input: { capacity: number }): Promise<Game> {
    const startsAt = new Date('2026-09-01T16:00:00.000Z');
    this.game = {
      id: asGameId(randomUUID()),
      groupId: asGroupId(randomUUID()),
      sourceTemplateId: null,
      name: 'Recovery game',
      venue: 'Arena',
      address: null,
      startsAt,
      durationMinutes: 120,
      capacity: input.capacity,
      timeZone: 'UTC',
      registrationOpensAt: new Date('2026-08-31T16:00:00.000Z'),
      registrationClosesAt: null,
      tentativePromptAt: new Date('2026-09-01T13:00:00.000Z'),
      tentativeResponseDeadline: new Date('2026-09-01T14:00:00.000Z'),
      reminderAt: new Date('2026-09-01T15:00:00.000Z'),
      memberPriorityEnabled: true,
      totalCostMinor: null,
      currency: 'RUB',
      roundingMode: 'EXACT',
      state: 'OPEN',
      scheduleRevision: 1,
      canonicalTelegramMessageId: null,
    };
    return this.game;
  }

  public async registerTentative(
    game: Game,
    telegramId: string,
  ): Promise<TelegramId> {
    if (game.id === undefined) throw new Error('Persisted game is required');
    const registrationId = asRegistrationId(randomUUID());
    const identity = asTelegramId(telegramId);
    this.registrations.push({
      id: registrationId,
      kind: 'MEMBER',
      state: 'TENTATIVE',
      manualRank: null,
      membershipPriority: 1,
      confirmedAt: null,
    });
    this.telegramIds.set(registrationId, identity);
    return identity;
  }

  public async reconcileJobs(): Promise<void> {
    if (this.game === undefined) throw new Error('Game is required');
    await this.reconciler.execute(this.game, this.registrations);
  }

  public async flushRedis(): Promise<void> {
    this.redis.clear();
  }

  public async redisJobCount(): Promise<number> {
    return this.redis.count();
  }

  public async drainWorkers(): Promise<void> {
    const due = this.redis.due(this.clock.now());
    for (const job of due) {
      if (job.kind === 'REQUEST_TENTATIVE_CONFIRMATION') {
        await Promise.all(
          this.registrations
            .filter((registration) => registration.state === 'TENTATIVE')
            .map((registration) => this.sendConfirmation(job, registration)),
        );
      }
      this.completed.add(job.id);
      await this.redis.remove(job.id);
      await this.postgresJobs.remove(job.groupId, job.gameId, job.id);
    }
  }

  public async pendingRequiredJobs(gameId: GameId): Promise<string[]> {
    if (this.game?.id !== gameId) return [];
    return requiredJobsForGame(this.game, this.registrations)
      .filter(
        (job) =>
          job.runAt.getTime() <= this.clock.now().getTime() &&
          !this.completed.has(job.id),
      )
      .map((job) => job.id);
  }

  private async sendConfirmation(
    job: RequiredJob,
    registration: RegistrationCandidate,
  ): Promise<void> {
    const telegramUserId = this.telegramIds.get(registration.id)!;
    const intent: NotificationIntent = {
      notificationType: 'TENTATIVE_CONFIRMATION',
      groupId: job.groupId,
      gameId: job.gameId,
      groupChatId: asTelegramId('-1001'),
      recipient: {
        kind: 'MEMBER',
        telegramUserId,
        inviterTelegramUserId: null,
        displayName: 'Игрок',
      },
      text: 'Подтвердите участие в игре',
      buttons: [
        {
          text: 'Подтверждаю',
          callbackData: tentativeCallback(registration.id, 0, 'confirm'),
        },
        {
          text: 'Снимаюсь',
          callbackData: tentativeCallback(registration.id, 0, 'withdraw'),
        },
      ],
    };
    await this.sender.send(intent);
  }
}

class InMemoryScheduledJobStore implements ScheduledJobStore {
  private readonly jobs = new Map<string, RequiredJob>();

  public async listForGame(): Promise<readonly StoredScheduledJob[]> {
    return [...this.jobs.values()];
  }

  public async upsert(job: RequiredJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  public async remove(
    _groupId: RequiredJob['groupId'],
    _gameId: RequiredJob['gameId'],
    id: string,
  ): Promise<void> {
    this.jobs.delete(id);
  }
}

class InMemoryDelayedJobScheduler implements DelayedJobScheduler {
  private readonly jobs = new Map<string, RequiredJob>();

  public async ensure(job: RequiredJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  public async remove(id: string): Promise<void> {
    this.jobs.delete(id);
  }

  public clear(): void {
    this.jobs.clear();
  }

  public count(): number {
    return this.jobs.size;
  }

  public due(now: Date): RequiredJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.runAt.getTime() <= now.getTime())
      .sort((left, right) => left.runAt.getTime() - right.runAt.getTime());
  }
}
