import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import type { ConferenceActor } from '../conferences/conference.types.js';
import { CurrentActor } from '../conferences/decorators/current-actor.decorator.js';
import { ConferenceActorGuard } from '../conferences/guards/conference-actor.guard.js';
import { CollaborationAuthService } from './collaboration/collaboration-auth.service.js';
import { ConferenceDocumentsService } from './conference-documents.service.js';
import { DocumentsService } from './documents.service.js';
import { AttachDocumentDto } from './dto/attach-document.dto.js';
import {
  ConferenceDocumentDto,
  ConferenceDocumentListDto,
} from './dto/conference-document.dto.js';
import { ConferenceDocumentListQueryDto } from './dto/conference-document-list-query.dto.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { DocumentAccessDto } from './dto/document-access.dto.js';
import { DocumentListQueryDto } from './dto/document-list-query.dto.js';
import { DocumentDto, DocumentListDto } from './dto/document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';

const UNAUTHORIZED = 'Нет или недействителен access token';
const UNAUTHORIZED_ACTOR =
  'Нет access token или гостевого токена, либо токен недействителен';
const ROOM_NOT_FOUND =
  'Комната не найдена, удалена или принадлежит другому пользователю';
const DOCUMENT_NOT_FOUND = 'Документ не найден';
const CONFERENCE_NOT_FOUND =
  'Конференция не найдена или текущий пользователь не организатор и не участник';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('rooms/:roomId/documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly collaborationAuth: CollaborationAuthService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Документы комнаты',
    description:
      'Только для владельца комнаты. Поиск по названию, сортировка и пагинация. Удалённые документы скрыты.',
  })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiOkResponse({ type: DocumentListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры списка' })
  @ApiNotFoundResponse({ description: ROOM_NOT_FOUND })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  list(
    @CurrentUser() user: AuthUser,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Query() query: DocumentListQueryDto,
  ): Promise<DocumentListDto> {
    return this.documentsService.list(user.id, roomId, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Создать документ комнаты',
    description:
      'Документ принадлежит комнате и может использоваться на разных её конференциях. Создатель берётся из access token.',
  })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiCreatedResponse({ type: DocumentDto })
  @ApiBadRequestResponse({ description: 'Пустое или слишком длинное название' })
  @ApiNotFoundResponse({ description: ROOM_NOT_FOUND })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  create(
    @CurrentUser() user: AuthUser,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Body() dto: CreateDocumentDto,
  ): Promise<DocumentDto> {
    return this.documentsService.create(user.id, roomId, dto);
  }

  @Get(':documentId')
  @ApiOperation({
    summary: 'Информация о документе',
    description:
      'Метаданные без содержимого. Содержимое читается через Hocuspocus.',
  })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOkResponse({ type: DocumentDto })
  @ApiNotFoundResponse({
    description: `${ROOM_NOT_FOUND}, либо ${DOCUMENT_NOT_FOUND}`,
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<DocumentDto> {
    return this.documentsService.getOne(user.id, roomId, documentId);
  }

  @Patch(':documentId')
  @ApiOperation({ summary: 'Переименовать документ' })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOkResponse({ type: DocumentDto })
  @ApiBadRequestResponse({ description: 'Пустое или слишком длинное название' })
  @ApiNotFoundResponse({
    description: `${ROOM_NOT_FOUND}, либо ${DOCUMENT_NOT_FOUND}`,
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  rename(
    @CurrentUser() user: AuthUser,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
    @Body() dto: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    return this.documentsService.rename(user.id, roomId, documentId, dto);
  }

  @Delete(':documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Логически удалить документ',
    description:
      'Редакторы отключаются. Связи уже прошедших конференций и название в них сохраняются.',
  })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: `${ROOM_NOT_FOUND}, либо ${DOCUMENT_NOT_FOUND}`,
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<void> {
    return this.documentsService.remove(user.id, roomId, documentId);
  }

  @OptionalAuth()
  @Post(':documentId/access')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ConferenceActorGuard)
  @ApiSecurity('guest')
  @ApiOperation({
    summary: 'Токен для открытия документа в Hocuspocus',
    description:
      'Нужны активная конференция этой комнаты, участие в ней с открытым подключением и прикрепление документа. ' +
      'Участие в прошлой конференции само по себе содержимое не открывает: при новом подключении читается актуальная версия. ' +
      'Идентификатор конференции клиент не передаёт.',
  })
  @ApiParam({ name: 'roomId', format: 'uuid' })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiOkResponse({ type: DocumentAccessDto })
  @ApiNotFoundResponse({
    description:
      'Документ не найден, либо у вызывающего нет отношения к комнате',
  })
  @ApiForbiddenResponse({
    description:
      'Нет активной конференции, открытого подключения или документ не прикреплён',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  access(
    @CurrentActor() actor: ConferenceActor,
    @Param('roomId', new ParseUUIDPipe()) roomId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<DocumentAccessDto> {
    return this.collaborationAuth.issueToken(roomId, documentId, actor);
  }
}

@ApiTags('conference documents')
@ApiBearerAuth()
@ApiSecurity('guest')
@OptionalAuth()
@UseGuards(ConferenceActorGuard)
@Controller('conferences/:conferenceId/documents')
export class ConferenceDocumentsController {
  constructor(
    private readonly conferenceDocumentsService: ConferenceDocumentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Документы, использованные на конференции',
    description:
      'Название, идентификатор документа и время редактирования в рамках этой конференции. ' +
      'Содержимое не копируется: при последующем открытии на новой конференции видна актуальная версия. ' +
      'После завершения список не меняется. Гостю завершённая конференция недоступна. ' +
      'editedOnly=true оставляет только документы с фактическими правками.',
  })
  @ApiParam({ name: 'conferenceId', format: 'uuid' })
  @ApiOkResponse({ type: ConferenceDocumentListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры списка' })
  @ApiNotFoundResponse({ description: CONFERENCE_NOT_FOUND })
  @ApiForbiddenResponse({
    description: 'Гость запрашивает завершённую конференцию',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  list(
    @CurrentActor() actor: ConferenceActor,
    @Param('conferenceId', new ParseUUIDPipe()) conferenceId: string,
    @Query() query: ConferenceDocumentListQueryDto,
  ): Promise<ConferenceDocumentListDto> {
    return this.conferenceDocumentsService.list(conferenceId, actor, query);
  }

  @Post()
  @ApiOperation({
    summary: 'Прикрепить документ комнаты к конференции',
    description:
      'Для организатора, HOST и MODERATOR, пока конференция не завершена. Документ должен принадлежать той же комнате. Повторное прикрепление не создаёт вторую связь.',
  })
  @ApiParam({ name: 'conferenceId', format: 'uuid' })
  @ApiCreatedResponse({ type: ConferenceDocumentDto })
  @ApiBadRequestResponse({ description: 'Некорректный documentId' })
  @ApiNotFoundResponse({
    description: `${CONFERENCE_NOT_FOUND}, либо документ не принадлежит комнате конференции`,
  })
  @ApiForbiddenResponse({
    description: 'Недостаточно прав: нужен организатор, HOST или MODERATOR',
  })
  @ApiConflictResponse({
    description: 'Конференция завершена или документ уже прикреплён',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  attach(
    @CurrentActor() actor: ConferenceActor,
    @Param('conferenceId', new ParseUUIDPipe()) conferenceId: string,
    @Body() dto: AttachDocumentDto,
  ): Promise<ConferenceDocumentDto> {
    return this.conferenceDocumentsService.attach(conferenceId, actor, dto);
  }

  @Delete(':documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Открепить документ от незавершённой конференции',
    description:
      'Для организатора, HOST и MODERATOR. Содержимое документа комнаты не удаляется. После завершения конференции связь не меняется.',
  })
  @ApiParam({ name: 'conferenceId', format: 'uuid' })
  @ApiParam({ name: 'documentId', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: `${CONFERENCE_NOT_FOUND}, либо документ не прикреплён`,
  })
  @ApiForbiddenResponse({
    description: 'Недостаточно прав: нужен организатор, HOST или MODERATOR',
  })
  @ApiConflictResponse({ description: 'Конференция завершена' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED_ACTOR })
  detach(
    @CurrentActor() actor: ConferenceActor,
    @Param('conferenceId', new ParseUUIDPipe()) conferenceId: string,
    @Param('documentId', new ParseUUIDPipe()) documentId: string,
  ): Promise<void> {
    return this.conferenceDocumentsService.detach(
      conferenceId,
      documentId,
      actor,
    );
  }
}
