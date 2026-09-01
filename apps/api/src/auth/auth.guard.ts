import {
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedPrincipal } from '@volley/application';
import type { TelegramId, UserId } from '@volley/domain';
import type { FastifyRequest } from 'fastify';
import type { MiniAppInitDataVerifier } from './mini-app-init-data.verifier.js';

export const MINI_APP_INIT_DATA_VERIFIER = Symbol(
  'MINI_APP_INIT_DATA_VERIFIER',
);
export const AUTHENTICATED_PRINCIPAL_RESOLVER = Symbol(
  'AUTHENTICATED_PRINCIPAL_RESOLVER',
);

export interface AuthenticatedPrincipalResolver {
  resolve(telegramUserId: TelegramId): Promise<UserId | null>;
}

type AuthenticatedRequest = FastifyRequest & {
  principal?: AuthenticatedPrincipal;
};

@Injectable()
export class MiniAppAuthGuard implements CanActivate {
  public constructor(
    @Inject(MINI_APP_INIT_DATA_VERIFIER)
    private readonly verifier: MiniAppInitDataVerifier,
    @Inject(AUTHENTICATED_PRINCIPAL_RESOLVER)
    private readonly principals: AuthenticatedPrincipalResolver,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string'
        ? /^tma ([^\r\n]+)$/i.exec(authorization)
        : null;
    if (match?.[1] === undefined) throw new UnauthorizedException();

    let telegramUserId: TelegramId;
    try {
      telegramUserId = this.verifier.verify(match[1]).telegramUserId;
    } catch {
      throw new UnauthorizedException();
    }
    const userId = await this.principals.resolve(telegramUserId);
    if (userId === null) throw new UnauthorizedException();

    request.principal = {
      userId,
      telegramUserId,
      source: 'MINI_APP',
    };
    return true;
  }
}

export const Principal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.principal === undefined) throw new UnauthorizedException();
    return request.principal;
  },
);
