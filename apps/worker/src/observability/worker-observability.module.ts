import { Controller, Get, Global, Header, Module } from '@nestjs/common';
import { JsonLogger, MetricsRegistry } from '@volley/application';
import { parseEnv } from '@volley/config';

@Controller()
class WorkerObservabilityController {
  public constructor(private readonly metrics: MetricsRegistry) {}

  @Get('health/live')
  public live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  public ready(): { status: 'ok' } {
    return { status: 'ok' };
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
