import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { UserDto } from '../users/dto/user.dto.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants.js';
import { AuthService } from './auth.service.js';
import type { AuthUser, ClientMeta, IssuedTokens } from './auth.types.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { AuthResponseDto } from './dto/auth-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { SessionDto } from './dto/session.dto.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import { SessionsService } from './sessions.service.js';

const MINUTE_MS = 60_000;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly refreshCookieOptions: CookieSerializeOptions;
  private readonly csrfCookieOptions: CookieSerializeOptions;

  constructor(
    private readonly authService: AuthService,
    private readonly sessionsService: SessionsService,
    configService: ConfigService,
  ) {
    const apiPrefix = configService.getOrThrow<string>('app.apiPrefix');
    const base = {
      secure: true,
      sameSite: 'strict',
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    } as const;

    this.refreshCookieOptions = {
      ...base,
      httpOnly: true,
      path: `/${apiPrefix}/auth`,
    };
    this.csrfCookieOptions = { ...base, httpOnly: false, path: '/' };
  }

  @Public()
  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 10 * MINUTE_MS } })
  @ApiOperation({ summary: 'Регистрация по email и паролю' })
  @ApiCreatedResponse({
    type: AuthResponseDto,
    description: 'Пользователь создан, refresh token установлен в cookie',
  })
  @ApiConflictResponse({ description: 'Email уже занят' })
  @ApiTooManyRequestsResponse({ description: 'Слишком много запросов' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const tokens = await this.authService.register(dto, clientMeta(request));

    return this.sendTokens(reply, tokens);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Вход по email и паролю' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Неверный email или пароль' })
  @ApiForbiddenResponse({ description: 'Учётная запись заблокирована' })
  @ApiTooManyRequestsResponse({ description: 'Слишком много запросов' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const tokens = await this.authService.login(dto, clientMeta(request));

    return this.sendTokens(reply, tokens);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard, CsrfGuard)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiCookieAuth()
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'Обновление access token с ротацией refresh token',
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token недействителен, истёк или уже использован',
  })
  @ApiForbiddenResponse({
    description: 'Неверный CSRF-токен или учётная запись заблокирована',
  })
  @ApiTooManyRequestsResponse({ description: 'Слишком много запросов' })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    try {
      const tokens = await this.authService.refresh(
        request.cookies[REFRESH_TOKEN_COOKIE]!,
        clientMeta(request),
      );

      return this.sendTokens(reply, tokens);
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ForbiddenException
      ) {
        this.clearCookies(reply);
      }
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(CsrfGuard)
  @ApiCookieAuth()
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'Выход из текущей сессии' })
  @ApiNoContentResponse({ description: 'Сессия отозвана, cookie очищены' })
  @ApiUnauthorizedResponse({ description: 'Refresh token отсутствует' })
  @ApiForbiddenResponse({ description: 'Неверный CSRF-токен' })
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logout(request.cookies[REFRESH_TOKEN_COOKIE]!);
    this.clearCookies(reply);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Выход со всех устройств' })
  @ApiNoContentResponse({ description: 'Все сессии пользователя отозваны' })
  @ApiUnauthorizedResponse({ description: 'Нет или недействителен access token' })
  async logoutAll(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.authService.logoutAll(user.id);
    this.clearCookies(reply);
  }

  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Активные сессии текущего пользователя' })
  @ApiOkResponse({ type: SessionDto, isArray: true })
  @ApiUnauthorizedResponse({ description: 'Нет или недействителен access token' })
  async listSessions(@CurrentUser() user: AuthUser): Promise<SessionDto[]> {
    const sessions = await this.sessionsService.listActive(user.id);

    return sessions.map((session) =>
      SessionDto.fromEntity(session, user.sessionId),
    );
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Отзыв сессии по id' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id сессии' })
  @ApiNoContentResponse({ description: 'Сессия отозвана' })
  @ApiNotFoundResponse({ description: 'Активная сессия не найдена' })
  @ApiUnauthorizedResponse({ description: 'Нет или недействителен access token' })
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.sessionsService.revokeForUser(id, user.id);

    if (id === user.sessionId) {
      this.clearCookies(reply);
    }
  }

  private sendTokens(reply: FastifyReply, tokens: IssuedTokens): AuthResponseDto {
    reply.setCookie(
      REFRESH_TOKEN_COOKIE,
      tokens.refreshToken,
      this.refreshCookieOptions,
    );
    reply.setCookie(CSRF_TOKEN_COOKIE, tokens.csrfToken, this.csrfCookieOptions);
    reply.header('Cache-Control', 'no-store');

    return {
      accessToken: tokens.accessToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      csrfToken: tokens.csrfToken,
      user: UserDto.fromEntity(tokens.user),
    };
  }

  private clearCookies(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_TOKEN_COOKIE, this.refreshCookieOptions);
    reply.clearCookie(CSRF_TOKEN_COOKIE, this.csrfCookieOptions);
  }
}

function clientMeta(request: FastifyRequest): ClientMeta {
  return {
    ipAddress: request.ip || null,
    userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
  };
}
