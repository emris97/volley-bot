import { Global, Module } from '@nestjs/common';
import { MetricsRegistry } from '@volley/application';
import { MetricsController } from './metrics.controller.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsRegistry],
  exports: [MetricsRegistry],
})
export class ObservabilityModule {}
