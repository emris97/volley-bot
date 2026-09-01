import {
  Controller,
  Get,
  Global,
  Header,
  Inject,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JsonLogger, MetricsRegistry } from '@volley/application';
import { parseEnv } from '@volley/config';
import {
  WORKER_DEPENDENCIES,
  type WorkerDependencies,
} from '../infrastructure/worker-dependencies.module.js';

@Controller()
class WorkerObservabilityController {
  public constructor(
    private readonly metrics: MetricsRegistry,
    @Inject(WORKER_DEPENDENCIES)
    private readonly dependencies: WorkerDependencies,
  ) {}

  @Get('health/live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  public async ready(): Promise<{ status: 'ok' }> {
    try {
      if (this.dependencies.redis.status !== 'ready') {
        throw new Error('Redis is not ready');
      }
      const [, redisResponse] = await Promise.all([
        this.dependencies.pool.query('SELECT 1'),
        this.dependencies.redis.ping(),
      ]);
      if (redisResponse !== 'PONG') throw new Error('Redis ping failed');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' });
    }
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  public renderMetrics(): string {
    return this.metrics.render();
  }
}

@Global()
@Module({
  controllers: [WorkerObservabilityController],
  providers: [
    MetricsRegistry,
    {
      provide: JsonLogger,
      useFactory: (): JsonLogger => {
        const env = parseEnv(process.env);
        return new JsonLogger({
          level: env.LOG_LEVEL,
          secrets: [
            env.BOT_TOKEN,
            env.TELEGRAM_WEBHOOK_SECRET,
            env.DATABASE_URL,
            env.REDIS_URL,
          ],
        });
      },
    },
  ],
  exports: [MetricsRegistry, JsonLogger],
})
export class WorkerObservabilityModule {}
