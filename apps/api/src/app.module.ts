import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { TelegramModule } from './telegram/telegram.module.js';

@Module({ imports: [HealthModule, TelegramModule] })
export class AppModule {}
