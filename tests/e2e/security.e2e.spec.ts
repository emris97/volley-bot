import { expect, it } from 'vitest';
import {
  JsonLogger,
  MetricsRegistry,
  type LogOutput,
} from '@volley/application';

it('redacts secrets and sensitive transport data from JSON logs', () => {
  const output: string[] = [];
  const secrets = {
    botToken: '123456:ABCDEFGHIJKLMNOPQRSTUV',
    webhookSecret: 'known-webhook-secret',
    databaseUrl: 'postgresql://volley:database-password@postgres:5432/volley',
    redisUrl: 'redis://:redis-password@redis:6379',
  };
  const logger = new JsonLogger({
    output: (line: LogOutput) => output.push(line),
    secrets: Object.values(secrets),
  });

  logger.info('webhook rejected', {
    correlationId: 'correlation-1',
    updateId: '42',
    groupId: 'group-1',
    gameId: 'game-1',
    jobId: 'job-1',
    BOT_TOKEN: secrets.botToken,
    telegramWebhookSecret: secrets.webhookSecret,
    databaseUrl: secrets.databaseUrl,
    redisUrl: secrets.redisUrl,
    databaseDiagnostic: 'password database-password for user volley',
    redisDiagnostic: 'redis-password',
    rawInitData: 'query_id=secret-query&auth_date=1&hash=secret-hash',
    authorization: 'tma query_id=secret-query&hash=secret-hash',
    messageContent: 'private message body',
    nested: { text: 'sensitive Telegram text' },
  });

  const serialized = output.join('\n');
  for (const secret of Object.values(secrets)) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toContain('secret-query');
  expect(serialized).not.toContain('database-password');
  expect(serialized).not.toContain('redis-password');
  expect(serialized).not.toContain('private message body');
  expect(serialized).not.toContain('sensitive Telegram text');
  expect(JSON.parse(output[0]!)).toMatchObject({
    level: 'info',
    message: 'webhook rejected',
    correlationId: 'correlation-1',
    updateId: '42',
    groupId: 'group-1',
    gameId: 'game-1',
    jobId: 'job-1',
  });
});

it('exports production operational metrics without secret-bearing labels', () => {
  const metrics = new MetricsRegistry();
  metrics.recordWebhook('success', 0.025);
  metrics.recordWebhook('unauthorized', 0.005);
  metrics.setQueueDepth('outbox', 3);
  metrics.recordJobRetry('notifications');
  metrics.observeOutboxLag(12.5);
  metrics.recordNotificationFailure('private');
  metrics.recordTransactionConflict('registration');

  const body = metrics.render();
  expect(body).toContain('volley_webhook_requests_total{result="success"} 1');
  expect(body).toContain('volley_webhook_duration_seconds_count 2');
  expect(body).toContain('volley_queue_depth{queue="outbox"} 3');
  expect(body).toContain('volley_job_retries_total{queue="notifications"} 1');
  expect(body).toContain('volley_outbox_lag_seconds_count 1');
  expect(body).toContain(
    'volley_notification_failures_total{channel="private"} 1',
  );
  expect(body).toContain(
    'volley_transaction_conflicts_total{operation="registration"} 1',
  );
});
