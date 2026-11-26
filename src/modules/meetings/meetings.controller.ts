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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CreateMeetingDto } from './dto/create-meeting.dto.js';
import { MeetingListQueryDto } from './dto/meeting-list-query.dto.js';
import { MeetingDto, MeetingListDto } from './dto/meeting.dto.js';
import { UpdateMeetingDto } from './dto/update-meeting.dto.js';
import { MeetingsService } from './meetings.service.js';

const UNAUTHORIZED = 'Нет или недействителен access token';
const ROOM_UNAVAILABLE =
  'Комната не найдена, удалена или пользователь не управляет её расписанием';

@ApiTags('meetings')
@ApiBearerAuth()
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Post()
  @ApiOperation({
    summary: 'Создать встречу',
    description:
      'Организатор берётся из access token, передать organizerId нельзя. ' +
      'Создавать встречу может владелец выбранной комнаты. ' +
      'Приглашение не даёт права подключиться к комнате.',
  })
  @ApiCreatedResponse({ type: MeetingDto })
  @ApiBadRequestResponse({
    description:
      'Пустое название, неверный интервал, дата без часового пояса, повторы в attendeeIds, ' +
      'организатор в списке приглашённых или пользователь, которого нельзя пригласить в эту комнату',
  })
  @ApiNotFoundResponse({
    description: `${ROOM_UNAVAILABLE}, либо приглашённый пользователь не найден`,
  })
  @ApiGoneResponse({
    description: 'Комната завершена или срок действия временной комнаты истёк',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMeetingDto,
  ): Promise<MeetingDto> {
    return this.meetingsService.create(user.id, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Мои встречи',
    description:
      'Встречи, где текущий пользователь организатор или приглашённый. ' +
      'from и to задают период по пересечению интервалов. Сортировка по startsAt. ' +
      'Встречи удалённых комнат скрыты. В закрытой комнате встреча видна, только пока пользователь остаётся владельцем или участником.',
  })
  @ApiOkResponse({ type: MeetingListDto })
  @ApiBadRequestResponse({
    description: 'Некорректные даты, период или параметры пагинации',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: MeetingListQueryDto,
  ): Promise<MeetingListDto> {
    return this.meetingsService.list(user.id, query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Информация о встрече',
    description:
      'Доступна организатору и приглашённым. ' +
      'В закрытой комнате пользователь должен по-прежнему быть владельцем или участником.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id встречи' })
  @ApiOkResponse({ type: MeetingDto })
  @ApiNotFoundResponse({ description: 'Встреча не найдена или нет доступа' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<MeetingDto> {
    return this.meetingsService.getOne(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Изменить встречу',
    description:
      'Только организатор. При смене комнаты или списка приглашённых права проверяются заново. ' +
      'organizerId изменить нельзя.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id встречи' })
  @ApiOkResponse({ type: MeetingDto })
  @ApiBadRequestResponse({
    description:
      'Пустой запрос, неверный интервал или приглашённых нельзя добавить в выбранную комнату',
  })
  @ApiForbiddenResponse({
    description:
      'Пользователь не организатор или больше не управляет расписанием комнаты',
  })
  @ApiNotFoundResponse({
    description:
      'Встреча не найдена, нет доступа, либо новая комната недоступна',
  })
  @ApiGoneResponse({
    description: 'Новая комната завершена или срок её действия истёк',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMeetingDto,
  ): Promise<MeetingDto> {
    return this.meetingsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Удалить встречу',
    description:
      'Только организатор. Приглашённые удаляются вместе со встречей.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id встречи' })
  @ApiNoContentResponse({ description: 'Встреча удалена' })
  @ApiForbiddenResponse({
    description: 'Удалять встречу может только организатор',
  })
  @ApiNotFoundResponse({ description: 'Встреча не найдена или нет доступа' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.meetingsService.remove(user.id, id);
  }
}
