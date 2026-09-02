import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { TelegramModule } from './telegram/telegram.module.js';
import { V1Module } from './v1/v1.module.js';

@Module({
  imports: [
    InfrastructureModule,
    ObservabilityModule,
    HealthModule,
    TelegramModule,
    V1Module,
  ],
})
export class AppModule {}
