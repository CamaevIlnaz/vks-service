import {
  Body,
  Controller,
  forwardRef,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ConferencesService } from '../conferences/conferences.service.js';
import type { ConferenceActor } from '../conferences/conference.types.js';
import { CurrentActor } from '../conferences/decorators/current-actor.decorator.js';
import { ConferenceActorGuard } from '../conferences/guards/conference-actor.guard.js';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import { CreateMediaTokenDto } from './dto/create-media-token.dto.js';
import { MediaRoomDto } from './dto/media-room.dto.js';
import { MediaTokenDto } from './dto/media-token.dto.js';
import { MediaService } from './media.service.js';

const UNAUTHORIZED_ACTOR =
  'Нет access token или гостевого токена, либо токен недействителен';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    @Inject(forwardRef(() => ConferencesService))
    private readonly conferencesService: ConferencesService,
  ) {}

  @OptionalAuth()
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Выдать токен подключения к LiveKit',
    description:
      'Токен живёт 5 минут — этого хватает, чтобы клиентский SDK установил WebRTC-соединение. Длительность звонка он не ограничивает. Конференция и сессия должны быть уже созданы входом по WebSocket. Повторный запрос безопасен и ничего не создаёт. Ключ LiveKit клиенту не отдаётся.',
  })
  @ApiOkResponse({ type: MediaTokenDto })
  @ApiNotFoundResponse({
    description: 'Подключение не найдено или принадлежит другому участнику',
  })
  @ApiForbiddenResponse({
    description:
      'Конференция не активна, подключение закрыто, нет WebSocket-присутствия или комната не допускает участника',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  createToken(
    @CurrentActor() actor: ConferenceActor,
    @Body() dto: CreateMediaTokenDto,
  ): Promise<MediaTokenDto> {
    return this.mediaService.createToken(actor, dto.sessionId);
  }

  @OptionalAuth()
  @Get('conferences/:conferenceId')
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Состояние медиакомнаты LiveKit',
    description:
      'Проверка серверного LiveKit API без клиентского SDK. Комната называется id конференции. Если LiveKit недоступен, управление комнатами и история конференций не затрагиваются: метод отвечает 503.',
  })
  @ApiParam({
    name: 'conferenceId',
    format: 'uuid',
    description: 'id конференции',
  })
  @ApiOkResponse({ type: MediaRoomDto })
  @ApiNotFoundResponse({
    description:
      'Конференция не найдена или текущий пользователь не организатор и не участник',
  })
  @ApiForbiddenResponse({
    description: 'Гость запрашивает завершённую конференцию',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  @ApiServiceUnavailableResponse({ description: 'LiveKit временно недоступен' })
  async describeConference(
    @CurrentActor() actor: ConferenceActor,
    @Param('conferenceId', new ParseUUIDPipe()) conferenceId: string,
  ): Promise<MediaRoomDto> {
    await this.conferencesService.getAccess(conferenceId, actor);

    return this.mediaService.describeConference(conferenceId);
  }
}
