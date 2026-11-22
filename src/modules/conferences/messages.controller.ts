import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import type { ConferenceActor } from './conference.types.js';
import { CurrentActor } from './decorators/current-actor.decorator.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { MessageDto, MessageListDto } from './dto/message.dto.js';
import { ConferenceActorGuard } from './guards/conference-actor.guard.js';
import { MessagesService } from './messages.service.js';

const UNAUTHORIZED_ACTOR =
  'Нет access token или гостевого токена, либо токен недействителен';
const CONFERENCE_NOT_FOUND =
  'Конференция не найдена или текущий пользователь не организатор и не участник';

@ApiTags('conference messages')
@ApiBearerAuth()
@ApiSecurity('guest')
@OptionalAuth()
@UseGuards(ConferenceActorGuard)
@Controller('conferences/:id/messages')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Get()
  @ApiOperation({
    summary: 'История сообщений конференции',
    description: 'Сообщения отсортированы от новых к старым.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiOkResponse({ type: MessageListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры пагинации' })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({
    description: 'Гость запрашивает завершённую конференцию',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  list(
    @CurrentActor() actor: ConferenceActor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<MessageListDto> {
    return this.messagesService.list(id, actor, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Отправить сообщение',
    description:
      'Доступно участнику с незакрытым подключением к активной конференции.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id конференции' })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiBadRequestResponse({
    description: 'Пустое или слишком длинное сообщение',
  })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({
    description: 'Отправитель не участник или у него нет активного подключения',
  })
  @ApiConflictResponse({ description: 'Конференция не активна' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  create(
    @CurrentActor() actor: ConferenceActor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateMessageDto,
  ): Promise<MessageDto> {
    return this.messagesService.create(id, actor, dto);
  }
}
