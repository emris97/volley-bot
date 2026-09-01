import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsRegistry } from '@volley/application';
import { MetricsController } from './metrics.controller.js';
import { RequestObservabilityInterceptor } from './request-observability.interceptor.js';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsRegistry,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestObservabilityInterceptor,
    },
  ],
  exports: [MetricsRegistry],
})
export class ObservabilityModule {}
