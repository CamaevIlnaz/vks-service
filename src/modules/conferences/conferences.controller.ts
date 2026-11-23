import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import type { ConferenceActor } from './conference.types.js';
import { ConferencesService } from './conferences.service.js';
import { CurrentActor } from './decorators/current-actor.decorator.js';
import { ConferenceDto } from './dto/conference.dto.js';
import { LeaveResponseDto } from './dto/leave-response.dto.js';
import { MutedMicrophoneDto } from './dto/mute-microphone.dto.js';
import { ParticipantListDto } from './dto/participant.dto.js';
import { ParticipantRemovedDto } from './dto/remove-participant.dto.js';
import { ConferenceActorGuard } from './guards/conference-actor.guard.js';

const UNAUTHORIZED_ACTOR =
  'Нет access token или гостевого токена, либо токен недействителен';
const CONFERENCE_NOT_FOUND =
  'Конференция не найдена или текущий пользователь не организатор и не участник';
const GUEST_ENDED_FORBIDDEN = 'Гость запрашивает завершённую конференцию';

@ApiTags('conferences')
@ApiBearerAuth()
@Controller('conferences')
export class ConferencesController {
  constructor(private readonly conferencesService: ConferencesService) {}

  @OptionalAuth()
  @Post('sessions/:id/leave')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Выйти из конференции с текущего устройства',
    description:
      'Закрывает только указанное подключение. Если незакрытых подключений не осталось, конференция переходит в EMPTY и через 3 минуты завершается. Повторный вызов безопасен.',
  })
  @ApiParam({
    name: 'id',
    format: 'uuid',
    description: 'id подключения (sessionId)',
  })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiNotFoundResponse({
    description: 'Подключение не найдено или принадлежит другому участнику',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  leave(
    @CurrentActor() actor: ConferenceActor,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeaveResponseDto> {
    return this.conferencesService.leave(id, actor);
  }

  @OptionalAuth()
  @Get(':id')
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({ summary: 'Информация о конференции' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiOkResponse({ type: ConferenceDto })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({ description: GUEST_ENDED_FORBIDDEN })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  findOne(
    @CurrentActor() actor: ConferenceActor,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConferenceDto> {
    return this.conferencesService.findOne(id, actor);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Завершить конференцию',
    description:
      'Только для организатора (владельца комнаты). Закрывает все подключения, удаляет медиакомнату LiveKit и рассылает conference:ended. Временная комната тоже завершается. Если LiveKit недоступен, конференция всё равно завершается. Повторный вызов безопасен.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiOkResponse({ type: ConferenceDto })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({ description: 'Текущий пользователь не организатор' })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  end(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConferenceDto> {
    return this.conferencesService.end(id, user.id);
  }

  @Post(':id/participants/:participantId/remove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Удалить участника из конференции',
    description:
      'Для владельца комнаты, HOST и MODERATOR. Сначала закрываются подключения участника в приложении, затем отключаются его медиасоединения LiveKit. Остальные участники не затрагиваются. История участника сохраняется. removeParticipant не отзывает уже выданный JWT до конца его короткого срока.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiParam({
    name: 'participantId',
    format: 'uuid',
    description: 'id участника',
  })
  @ApiOkResponse({ type: ParticipantRemovedDto })
  @ApiNotFoundResponse({ description: 'Участник или конференция не найдены' })
  @ApiForbiddenResponse({
    description:
      'Недостаточно прав, конференция не активна или цель — организатор',
  })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  removeParticipant(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('participantId', new ParseUUIDPipe()) participantId: string,
  ): Promise<ParticipantRemovedDto> {
    return this.conferencesService.removeParticipant(
      id,
      participantId,
      user.id,
    );
  }

  @Post(':id/sessions/:sessionId/disconnect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Отключить одно устройство участника',
    description:
      'Для владельца комнаты, HOST и MODERATOR. Закрывает только указанное подключение и его медиасоединение. Другие устройства того же пользователя остаются в конференции.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'id подключения устройства',
  })
  @ApiOkResponse({ type: LeaveResponseDto })
  @ApiNotFoundResponse({ description: 'Подключение не найдено в конференции' })
  @ApiForbiddenResponse({
    description: 'Недостаточно прав или конференция не активна',
  })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  disconnectSession(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<LeaveResponseDto> {
    return this.conferencesService.disconnectSession(id, sessionId, user.id);
  }

  @Post(':id/sessions/:sessionId/microphone/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Отключить микрофон устройства',
    description:
      'Для владельца комнаты, HOST и MODERATOR. Глушит микрофон одного LiveKit identity и запрещает его в следующих токенах этой сессии. Камера и демонстрация экрана сохраняются. Другие устройства участника не затрагиваются.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiParam({
    name: 'sessionId',
    format: 'uuid',
    description: 'id подключения устройства',
  })
  @ApiOkResponse({ type: MutedMicrophoneDto })
  @ApiNotFoundResponse({ description: 'Подключение не найдено в конференции' })
  @ApiForbiddenResponse({
    description:
      'Недостаточно прав, подключение закрыто или конференция не активна',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Запрет сохранён для следующих токенов, но LiveKit не подтвердил mute текущего соединения',
  })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  muteMicrophone(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<MutedMicrophoneDto> {
    return this.conferencesService.muteMicrophone(id, sessionId, user.id);
  }

  @OptionalAuth()
  @Get(':id/participants')
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Участники конференции',
    description:
      'Каждый участник возвращается один раз независимо от числа устройств; activeSessionsCount — число незакрытых подключений.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiOkResponse({ type: ParticipantListDto })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({ description: GUEST_ENDED_FORBIDDEN })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  listParticipants(
    @CurrentActor() actor: ConferenceActor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<ParticipantListDto> {
    return this.conferencesService.listParticipants(id, actor, query);
  }
}
