import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';

export const GUEST_TOKEN_HEADER = 'x-guest-token';
export const GUEST_TOKEN_AUDIENCE = 'vks-guest';
export const GUEST_TOKEN_TTL_SECONDS = 24 * 60 * 60;

interface GuestTokenPayload {
  sub: string;
}

/** guestId генерирует только сервер; клиент может лишь предъявить выданный ему подписанный токен. */
@Injectable()
export class GuestTokensService {
  constructor(private readonly jwtService: JwtService) {}

  sign(guestId: string): Promise<string> {
    const payload: GuestTokenPayload = { sub: guestId };

    return this.jwtService.signAsync(payload);
  }

  async verify(token: string): Promise<string | null> {
    try {
      const payload =
        await this.jwtService.verifyAsync<GuestTokenPayload>(token);

      return isUUID(payload.sub) ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
