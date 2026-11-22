import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AuthSession,
  User,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferenceSessionsService } from '../conferences/conference-sessions.service.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './auth.constants.js';
import type { AuthUser, ClientMeta } from './auth.types.js';
import { safeEqual, TokensService } from './tokens.service.js';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokensService: TokensService,
    private readonly conferenceSessionsService: ConferenceSessionsService,
  ) {}

  async create(
    userId: number,
    meta: ClientMeta,
  ): Promise<{ sessionId: string; refreshToken: string }> {
    const sessionId = randomUUID();
    const { token, hash } = this.tokensService.createRefreshToken(sessionId);

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId,
        refreshTokenHash: hash,
        expiresAt: this.refreshExpiresAt(new Date()),
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    return { sessionId, refreshToken: token };
  }

  async rotate(
    refreshToken: string,
    meta: ClientMeta,
  ): Promise<{ user: User; sessionId: string; refreshToken: string }> {
    const parsed = this.tokensService.parseRefreshToken(refreshToken);

    if (!parsed) {
      throw new UnauthorizedException('Недействительный refresh token');
    }

    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { id: parsed.sessionId },
      include: { user: true },
    });

    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedException('Сессия завершена');
    }

    if (!safeEqual(session.refreshTokenHash, parsed.hash)) {
      await this.revoke(session.id);
      throw new UnauthorizedException(
        'Повторное использование refresh token, сессия отозвана',
      );
    }

    if (session.user.status !== UserStatus.ACTIVE) {
      await this.revoke(session.id);
      throw new ForbiddenException('Учётная запись заблокирована');
    }

    const next = this.tokensService.createRefreshToken(session.id);

    // Условие по старому хешу делает ротацию атомарной: из параллельных запросов с одним токеном выиграет только один.
    const { count } = await this.prisma.authSession.updateMany({
      where: {
        id: session.id,
        refreshTokenHash: parsed.hash,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        refreshTokenHash: next.hash,
        expiresAt: this.refreshExpiresAt(now),
        lastUsedAt: now,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    if (count === 0) {
      await this.revoke(session.id);
      throw new UnauthorizedException(
        'Повторное использование refresh token, сессия отозвана',
      );
    }

    return {
      user: session.user,
      sessionId: session.id,
      refreshToken: next.token,
    };
  }

  /** Проверяет access token, активность сессии и учётной записи. Используется для HTTP и WebSocket. */
  async authenticate(accessToken: string): Promise<AuthUser> {
    const payload = await this.tokensService.verifyAccessToken(accessToken);

    if (!payload) {
      throw new UnauthorizedException('Недействительный access token');
    }

    const session = await this.findActive(payload.sid, Number(payload.sub));

    if (!session) {
      throw new UnauthorizedException('Сессия завершена');
    }

    if (session.user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Учётная запись заблокирована');
    }

    return {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      sessionId: session.id,
    };
  }

  findActive(
    sessionId: string,
    userId: number,
  ): Promise<(AuthSession & { user: User }) | null> {
    return this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { user: true },
    });
  }

  listActive(userId: number): Promise<AuthSession[]> {
    return this.prisma.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  async revokeForUser(sessionId: string, userId: number): Promise<void> {
    const { count } = await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('Сессия не найдена');
    }

    await this.conferenceSessionsService.closeForAuthSessions({
      id: sessionId,
    });
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const parsed = this.tokensService.parseRefreshToken(refreshToken);

    if (!parsed) {
      return;
    }

    const { count } = await this.prisma.authSession.updateMany({
      where: {
        id: parsed.sessionId,
        refreshTokenHash: parsed.hash,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    if (count > 0) {
      await this.conferenceSessionsService.closeForAuthSessions({
        id: parsed.sessionId,
      });
    }
  }

  async revokeAll(userId: number): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.conferenceSessionsService.closeForAuthSessions({ userId });
  }

  private async revoke(sessionId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.conferenceSessionsService.closeForAuthSessions({
      id: sessionId,
    });
  }

  private refreshExpiresAt(from: Date): Date {
    return new Date(from.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  }
}
