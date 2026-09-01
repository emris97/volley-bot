import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { runWithLogContext } from '@volley/application';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

@Injectable()
export class RequestObservabilityInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestObservabilityInterceptor.name);

  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const response = context.switchToHttp().getResponse<FastifyReply>();
    const correlationId = requestCorrelationId(
      request.headers['x-correlation-id'],
    );
    response.header('x-correlation-id', correlationId);

    return new Observable((subscriber) =>
      runWithLogContext(
        {
          correlationId,
          method: request.method,
          path: request.url,
        },
        () => {
          const subscription = next.handle().subscribe({
            next: (value) => subscriber.next(value),
            error: (error: unknown) => subscriber.error(error),
            complete: () => {
              runWithLogContext({ statusCode: response.statusCode }, () =>
                this.logger.log('HTTP request completed'),
              );
              subscriber.complete();
            },
          });
          return () => subscription.unsubscribe();
        },
      ),
    );
  }
}

const requestCorrelationId = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : randomUUID();
