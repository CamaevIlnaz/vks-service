import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { AccessTokenPayload } from './auth.types.js';

const REFRESH_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class TokensService {
  private readonly csrfSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.csrfSecret = configService.getOrThrow<string>('auth.csrfSecret');
  }

  signAccessToken(userId: number, sessionId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: String(userId), sid: sessionId };

    return this.jwtService.signAsync(payload);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload | null> {
    try {
      const payload =
        await this.jwtService.verifyAsync<AccessTokenPayload>(token);

      if (!/^\d+$/.test(payload.sub) || !isUUID(payload.sid)) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  /** Формат: `<sessionId>.<32 случайных байта в base64url>`. В БД хранится только SHA-256. */
  createRefreshToken(sessionId: string): { token: string; hash: string } {
    const token = `${sessionId}.${randomBytes(32).toString('base64url')}`;

    return { token, hash: this.hashToken(token) };
  }

  parseRefreshToken(token: string): { sessionId: string; hash: string } | null {
    const [sessionId, secret, ...rest] = token.split('.');

    if (
      rest.length > 0 ||
      !isUUID(sessionId) ||
      !REFRESH_SECRET_PATTERN.test(secret ?? '')
    ) {
      return null;
    }

    return { sessionId, hash: this.hashToken(token) };
  }

  /** CSRF-токен привязан к refresh token, поэтому подбросить свой cookie недостаточно. */
  createCsrfToken(refreshToken: string): string {
    return createHmac('sha256', this.csrfSecret)
      .update(refreshToken)
      .digest('base64url');
  }

  verifyCsrfToken(refreshToken: string, csrfToken: string): boolean {
    return safeEqual(this.createCsrfToken(refreshToken), csrfToken);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
