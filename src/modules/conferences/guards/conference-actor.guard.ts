import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConferenceActorRequest } from '../conference.types.js';
import {
  GUEST_TOKEN_HEADER,
  GuestTokensService,
} from '../guest-tokens.service.js';

/** Работает после глобального JwtAuthGuard на маршрутах с `@OptionalAuth()`. */
@Injectable()
export class ConferenceActorGuard implements CanActivate {
  constructor(private readonly guestTokensService: GuestTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ConferenceActorRequest>();

    if (request.user) {
      request.actor = { kind: 'user', userId: request.user.id };
      return true;
    }

    const token = request.headers[GUEST_TOKEN_HEADER];

    if (typeof token !== 'string' || !token) {
      throw new UnauthorizedException(
        'Требуется access token или гостевой токен',
      );
    }

    const guestId = await this.guestTokensService.verify(token);

    if (!guestId) {
      throw new UnauthorizedException('Недействительный гостевой токен');
    }

    request.actor = { kind: 'guest', guestId };

    return true;
  }
}
