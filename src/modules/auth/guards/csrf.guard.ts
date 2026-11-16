import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CSRF_HEADER, REFRESH_TOKEN_COOKIE } from '../auth.constants.js';
import { TokensService } from '../tokens.service.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly tokensService: TokensService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const refreshToken = request.cookies[REFRESH_TOKEN_COOKIE];

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token отсутствует');
    }

    const csrfToken = request.headers[CSRF_HEADER];

    if (
      typeof csrfToken !== 'string' ||
      !this.tokensService.verifyCsrfToken(refreshToken, csrfToken)
    ) {
      throw new ForbiddenException('Неверный CSRF-токен');
    }

    return true;
  }
}
