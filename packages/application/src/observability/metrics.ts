type WebhookResult = 'success' | 'unauthorized' | 'failure';

const histogramBuckets = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

interface HistogramState {
  count: number;
  sum: number;
  buckets: number[];
}

export class MetricsRegistry {
  private readonly webhookResults = new Map<WebhookResult, number>();
  private readonly queueDepth = new Map<string, number>();
  private readonly jobRetries = new Map<string, number>();
  private readonly notificationFailures = new Map<string, number>();
  private readonly transactionConflicts = new Map<string, number>();
  private readonly webhookDuration = createHistogram();
  private readonly outboxLag = createHistogram();

  public recordWebhook(result: WebhookResult, durationSeconds: number): void {
    increment(this.webhookResults, result);
    observe(this.webhookDuration, durationSeconds);
  }

  public setQueueDepth(queue: string, depth: number): void {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new Error('Queue depth must be a non-negative integer');
    }
    this.queueDepth.set(safeLabel(queue), depth);
  }

  public recordJobRetry(queue: string): void {
    increment(this.jobRetries, safeLabel(queue));
  }

  public observeOutboxLag(seconds: number): void {
    observe(this.outboxLag, seconds);
  }

  public recordNotificationFailure(channel: string): void {
    increment(this.notificationFailures, safeLabel(channel));
  }

  public recordTransactionConflict(operation: string): void {
    increment(this.transactionConflicts, safeLabel(operation));
  }

  public render(): string {
    return [
      '# HELP volley_webhook_requests_total Telegram webhook results.',
      '# TYPE volley_webhook_requests_total counter',
      ...renderMap(
        this.webhookResults,
        'volley_webhook_requests_total',
        'result',
      ),
      ...renderHistogram(
        'volley_webhook_duration_seconds',
        'Telegram webhook processing duration.',
        this.webhookDuration,
      ),
      '# HELP volley_queue_depth Current BullMQ queue depth.',
      '# TYPE volley_queue_depth gauge',
      ...renderMap(this.queueDepth, 'volley_queue_depth', 'queue'),
      '# HELP volley_job_retries_total Retried background jobs.',
      '# TYPE volley_job_retries_total counter',
      ...renderMap(this.jobRetries, 'volley_job_retries_total', 'queue'),
      ...renderHistogram(
        'volley_outbox_lag_seconds',
        'Age of unpublished PostgreSQL outbox events.',
        this.outboxLag,
      ),
      '# HELP volley_notification_failures_total Terminal notification failures.',
      '# TYPE volley_notification_failures_total counter',
      ...renderMap(
        this.notificationFailures,
        'volley_notification_failures_total',
        'channel',
      ),
      '# HELP volley_transaction_conflicts_total Database transaction conflicts.',
      '# TYPE volley_transaction_conflicts_total counter',
      ...renderMap(
        this.transactionConflicts,
        'volley_transaction_conflicts_total',
        'operation',
      ),
      '',
    ].join('\n');
  }
}

export const isTransactionConflictError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === '40001' || code === '40P01';
};

const createHistogram = (): HistogramState => ({
  count: 0,
  sum: 0,
  buckets: histogramBuckets.map(() => 0),
});

const observe = (histogram: HistogramState, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Metric observations must be finite and non-negative');
  }
  histogram.count += 1;
  histogram.sum += value;
  histogramBuckets.forEach((bucket, index) => {
    if (value <= bucket) histogram.buckets[index]! += 1;
  });
};

const increment = <Key>(values: Map<Key, number>, key: Key): void => {
  values.set(key, (values.get(key) ?? 0) + 1);
};

const renderMap = (
  values: ReadonlyMap<string, number>,
  metric: string,
  label: string,
): string[] =>
  [...values.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${metric}{${label}="${key}"} ${value}`);

const renderHistogram = (
  name: string,
  help: string,
  state: HistogramState,
): string[] => [
  `# HELP ${name} ${help}`,
  `# TYPE ${name} histogram`,
  ...histogramBuckets.map(
    (bucket, index) => `${name}_bucket{le="${bucket}"} ${state.buckets[index]}`,
  ),
  `${name}_bucket{le="+Inf"} ${state.count}`,
  `${name}_sum ${state.sum}`,
  `${name}_count ${state.count}`,
];

const safeLabel = (value: string): string =>
  /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : 'unknown';
