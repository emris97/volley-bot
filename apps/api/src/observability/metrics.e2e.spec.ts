import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { MetricsRegistry } from '@volley/application';
import { afterEach, expect, it } from 'vitest';
import { ObservabilityModule } from './observability.module.js';

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

it('serves the process metrics registry at the production endpoint', async () => {
  const module = await Test.createTestingModule({
    imports: [ObservabilityModule],
  }).compile();
  module.get(MetricsRegistry).recordWebhook('success', 0.01);
  app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const response = await app.inject({ method: 'GET', url: '/metrics' });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/plain');
  expect(response.body).toContain(
    'volley_webhook_requests_total{result="success"} 1',
  );
});
