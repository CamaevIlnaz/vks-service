import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus } from '../../../generated/prisma/client.js';
import { IS_PUBLIC_KEY } from '../auth.constants.js';
import type { AuthenticatedRequest } from '../auth.types.js';
import { SessionsService } from '../sessions.service.js';
import { TokensService } from '../tokens.service.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokensService: TokensService,
    private readonly sessionsService: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [type, token] = request.headers.authorization?.split(' ') ?? [];

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Требуется access token');
    }

    const payload = await this.tokensService.verifyAccessToken(token);

    if (!payload) {
      throw new UnauthorizedException('Недействительный access token');
    }

    const session = await this.sessionsService.findActive(
      payload.sid,
      Number(payload.sub),
    );

    if (!session) {
      throw new UnauthorizedException('Сессия завершена');
    }

    if (session.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Учётная запись заблокирована');
    }

    request.user = {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      sessionId: session.id,
    };

    return true;
  }
}
