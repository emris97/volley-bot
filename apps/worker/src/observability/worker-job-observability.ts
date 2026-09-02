import {
  isTransactionConflictError,
  type JsonLogger,
  type MetricsRegistry,
  runWithLogContext,
} from '@volley/application';

interface WorkerJobContext {
  queue:
    | 'outbox'
    | 'game-scheduler'
    | 'game-messages'
    | 'notifications'
    | 'payment-reminders';
  jobId: string;
  groupId?: string;
  gameId?: string;
  attemptsMade: number;
}

export const observeWorkerJob = async <Result>(
  metrics: MetricsRegistry | undefined,
  logger: JsonLogger | undefined,
  context: WorkerJobContext,
  action: () => Promise<Result>,
): Promise<Result> =>
  runWithLogContext(
    {
      jobId: context.jobId,
      ...(context.groupId === undefined ? {} : { groupId: context.groupId }),
      ...(context.gameId === undefined ? {} : { gameId: context.gameId }),
    },
    async () => {
      if (context.attemptsMade > 0) {
        metrics?.recordJobRetry(context.queue);
      }
      logger?.info('Worker job started');
      try {
        const result = await action();
        logger?.info('Worker job completed');
        return result;
      } catch (error) {
        if (isTransactionConflictError(error)) {
          metrics?.recordTransactionConflict(context.queue);
        }
        logger?.error('Worker job failed', { error });
        throw error;
      }
    },
  );
