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
import { ParticipantListDto } from './dto/participant.dto.js';
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
      'Только для организатора (владельца комнаты). Закрывает все подключения; временная комната тоже завершается. Повторный вызов безопасен.',
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
