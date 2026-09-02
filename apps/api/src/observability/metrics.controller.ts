import { Controller, Get, Header } from '@nestjs/common';
import { MetricsRegistry } from '@volley/application';

@Controller()
export class MetricsController {
  public constructor(private readonly metrics: MetricsRegistry) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  public render(): string {
    return this.metrics.render();
  }
}
