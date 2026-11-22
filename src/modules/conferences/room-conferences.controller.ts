import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGoneResponse,
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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import { ConferencesService } from './conferences.service.js';
import { ConferenceListDto } from './dto/conference.dto.js';
import { JoinResponseDto } from './dto/join-response.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';
import { GUEST_TOKEN_HEADER } from './guest-tokens.service.js';

@ApiTags('conferences')
@ApiBearerAuth()
@Controller('rooms')
export class RoomConferencesController {
  constructor(private readonly conferencesService: ConferencesService) {}

  @OptionalAuth()
  @Post('by-slug/:slug/join')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Подключиться к конференции в комнате',
    description:
      'Пользователь подключается под своим аккаунтом (access token). Гость указывает guestName; ' +
      'сервер выдаёт guestToken, который при повторных подключениях передаётся в X-Guest-Token. ' +
      'Если незавершённой конференции нет — создаётся новая. Каждый вызов создаёт отдельное подключение (устройство).',
  })
  @ApiParam({ name: 'slug', example: 'team-standup' })
  @ApiOkResponse({ type: JoinResponseDto })
  @ApiBadRequestResponse({
    description: 'Гость не указал имя или поля некорректны',
  })
  @ApiForbiddenResponse({
    description: 'Комната закрыта: подключиться может только организатор',
  })
  @ApiNotFoundResponse({ description: 'Комната не найдена или удалена' })
  @ApiGoneResponse({
    description: 'Комната завершена или срок её действия истёк',
  })
  @ApiUnauthorizedResponse({
    description: 'Передан недействительный access token',
  })
  @ApiTooManyRequestsResponse({ description: 'Слишком много запросов' })
  join(
    @CurrentUser() user: AuthUser | undefined,
    @Param('slug') slug: string,
    @Body() dto: JoinRoomDto,
    @Headers(GUEST_TOKEN_HEADER) guestToken: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<JoinResponseDto> {
    return this.conferencesService.join(
      slug,
      user ?? null,
      guestToken,
      dto,
      userAgent,
    );
  }

  @Get(':id/conferences')
  @ApiOperation({
    summary: 'История конференций комнаты',
    description:
      'Владелец видит все конференции комнаты (в том числе удалённой), другие пользователи — только те, в которых участвовали. Гостям недоступно.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiOkResponse({ type: ConferenceListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры пагинации' })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена или пользователь не участвовал в её конференциях',
  })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  listHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<ConferenceListDto> {
    return this.conferencesService.listRoomHistory(id, user.id, query);
  }
}
