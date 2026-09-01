import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JsonLogger } from '@volley/application';
import { parseEnv } from '@volley/config';
import { WorkerModule } from './worker.module.js';

async function bootstrap() {
  const env = parseEnv(process.env);
  const logger = new JsonLogger({
    level: env.LOG_LEVEL,
    secrets: [
      env.BOT_TOKEN,
      env.TELEGRAM_WEBHOOK_SECRET,
      env.DATABASE_URL,
      env.REDIS_URL,
    ],
  });
  const app = await NestFactory.create(WorkerModule, new FastifyAdapter(), {
    logger,
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}
void bootstrap().catch(() => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message: 'Worker startup failed', timestamp: new Date().toISOString() })}\n`,
  );
  process.exitCode = 1;
});
