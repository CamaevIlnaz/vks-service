import {
  ConflictException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { Prisma, User, UserStatus } from '../../generated/prisma/client.js';
import { UsersService } from '../users/users.service.js';
import type { ClientMeta, IssuedTokens } from './auth.types.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionsService } from './sessions.service.js';
import { TokensService } from './tokens.service.js';

const ARGON2_OPTIONS = { type: argon2.argon2id } as const;

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyPasswordHash: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly sessionsService: SessionsService,
    private readonly tokensService: TokensService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Проверка пароля для несуществующего email, чтобы время ответа не выдавало наличие аккаунта.
    this.dummyPasswordHash = await argon2.hash(
      randomBytes(32).toString('hex'),
      ARGON2_OPTIONS,
    );
  }

  async register(dto: RegisterDto, meta: ClientMeta): Promise<IssuedTokens> {
    if (await this.usersService.findByEmail(dto.email)) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }

    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    let user: User;
    try {
      user = await this.usersService.create({
        email: dto.email,
        passwordHash,
        name: dto.name,
        // Подтверждение email пока не реализовано.
        emailVerifiedAt: new Date(),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Пользователь с таким email уже существует',
        );
      }
      throw error;
    }

    return this.startSession(user, meta);
  }

  async login(dto: LoginDto, meta: ClientMeta): Promise<IssuedTokens> {
    const user = await this.usersService.findByEmail(dto.email);
    const passwordValid = await argon2.verify(
      user?.passwordHash ?? this.dummyPasswordHash,
      dto.password,
    );

    if (!user || !passwordValid) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Учётная запись заблокирована');
    }

    return this.startSession(user, meta);
  }

  async refresh(refreshToken: string, meta: ClientMeta): Promise<IssuedTokens> {
    const rotated = await this.sessionsService.rotate(refreshToken, meta);

    return this.issueTokens(
      rotated.user,
      rotated.sessionId,
      rotated.refreshToken,
    );
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessionsService.revokeByRefreshToken(refreshToken);
  }

  logoutAll(userId: number): Promise<void> {
    return this.sessionsService.revokeAll(userId);
  }

  private async startSession(
    user: User,
    meta: ClientMeta,
  ): Promise<IssuedTokens> {
    const { sessionId, refreshToken } = await this.sessionsService.create(
      user.id,
      meta,
    );

    return this.issueTokens(user, sessionId, refreshToken);
  }

  private async issueTokens(
    user: User,
    sessionId: string,
    refreshToken: string,
  ): Promise<IssuedTokens> {
    return {
      user,
      accessToken: await this.tokensService.signAccessToken(user.id, sessionId),
      refreshToken,
      csrfToken: this.tokensService.createCsrfToken(refreshToken),
    };
  }
}
