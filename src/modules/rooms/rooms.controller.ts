import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { OptionalAuth } from '../auth/decorators/optional-auth.decorator.js';
import { AddRoomMemberDto } from './dto/add-room-member.dto.js';
import { CreateQuickRoomDto } from './dto/create-quick-room.dto.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { PublicRoomDto } from './dto/public-room.dto.js';
import { RoomDto, RoomListDto } from './dto/room.dto.js';
import { RoomMemberDto, RoomMemberListDto } from './dto/room-member.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import { RoomsService } from './rooms.service.js';

const UNAUTHORIZED = 'Нет или недействителен access token';

@ApiTags('rooms')
@ApiBearerAuth()
@Controller('rooms')
export class RoomsController {
  constructor(private readonly roomsService: RoomsService) {}

  @Post()
  @ApiOperation({ summary: 'Создать постоянную комнату' })
  @ApiCreatedResponse({ type: RoomDto })
  @ApiBadRequestResponse({ description: 'Некорректные поля комнаты' })
  @ApiConflictResponse({ description: 'Ссылка уже занята' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRoomDto,
  ): Promise<RoomDto> {
    return this.roomsService.create(user.id, dto);
  }

  @Post('quick')
  @ApiOperation({
    summary: 'Создать временную комнату со случайным названием и ссылкой',
    description:
      'Комната завершается вместе со своей конференцией. Если конференцию не начали в течение 24 часов, комната истекает.',
  })
  @ApiCreatedResponse({ type: RoomDto })
  @ApiBadRequestResponse({ description: 'Некорректный тип доступа' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  createQuick(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateQuickRoomDto,
  ): Promise<RoomDto> {
    return this.roomsService.createQuick(user.id, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Комнаты текущего пользователя',
    description:
      'Свои комнаты и комнаты, в которые пользователя добавили. Удалённые комнаты скрыты.',
  })
  @ApiOkResponse({ type: RoomListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры пагинации' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<RoomListDto> {
    return this.roomsService.list(user.id, query);
  }

  @OptionalAuth()
  @Get('by-slug/:slug')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Комната по ссылке',
    description:
      'Доступно гостям. Возвращает только публичные данные. С access token `canJoin` учитывает права пользователя.',
  })
  @ApiParam({ name: 'slug', example: 'team-standup' })
  @ApiOkResponse({ type: PublicRoomDto })
  @ApiNotFoundResponse({ description: 'Комната не найдена или удалена' })
  @ApiUnauthorizedResponse({
    description: 'Передан недействительный access token',
  })
  @ApiTooManyRequestsResponse({ description: 'Слишком много запросов' })
  getBySlug(
    @CurrentUser() user: AuthUser | undefined,
    @Param('slug') slug: string,
  ): Promise<PublicRoomDto> {
    return this.roomsService.getPublicBySlug(slug, user?.id ?? null);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Подробная информация о своей комнате' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiOkResponse({ type: RoomDto })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, удалена или принадлежит другому пользователю',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RoomDto> {
    return this.roomsService.getOwned(user.id, id);
  }

  @Get(':id/members')
  @ApiOperation({
    summary: 'Пользователи, допущенные в комнату',
    description:
      'Только для владельца. Владелец в список не входит: его доступ задан полем ownerId. Для открытой комнаты список не ограничивает вход по ссылке.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiOkResponse({ type: RoomMemberListDto })
  @ApiBadRequestResponse({ description: 'Некорректные параметры пагинации' })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, удалена или принадлежит другому пользователю',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  listMembers(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<RoomMemberListDto> {
    return this.roomsService.listMembers(user.id, id, query);
  }

  @Post(':id/members')
  @ApiOperation({
    summary: 'Добавить пользователя в комнату',
    description:
      'Только владелец. Допуск выдаётся сразу, без подтверждения. Повторное добавление отвечает 409. В закрытой комнате добавленный пользователь может подключаться сразу.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiCreatedResponse({ type: RoomMemberDto })
  @ApiBadRequestResponse({
    description:
      'Некорректный userId, пользователь заблокирован или это владелец комнаты',
  })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, удалена, принадлежит другому пользователю, либо пользователь не зарегистрирован',
  })
  @ApiConflictResponse({
    description: 'Пользователь уже добавлен или комната завершена',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddRoomMemberDto,
  ): Promise<RoomMemberDto> {
    return this.roomsService.addMember(user.id, id, dto);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Удалить пользователя из комнаты',
    description:
      'Только владелец. В закрытой комнате активные сессии пользователя закрываются: сокеты, LiveKit и редактирование документов отключаются. История участия и сообщения сохраняются.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiParam({ name: 'userId', description: 'id пользователя', example: 2 })
  @ApiNoContentResponse({ description: 'Пользователь удалён из комнаты' })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, принадлежит другому пользователю, либо пользователя нет в списке',
  })
  @ApiConflictResponse({ description: 'Комната завершена' })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('userId', ParseIntPipe) userId: number,
  ): Promise<void> {
    return this.roomsService.removeMember(user.id, id, userId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Изменить название, ссылку или тип доступа комнаты',
    description:
      'При смене доступа с OPEN на CLOSED отключаются гости и пользователи, которых нет в списке допуска. Владелец и добавленные участники остаются.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiOkResponse({ type: RoomDto })
  @ApiBadRequestResponse({ description: 'Некорректные или пустые поля' })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, удалена или принадлежит другому пользователю',
  })
  @ApiConflictResponse({
    description: 'Ссылка уже занята или комната завершена',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoomDto,
  ): Promise<RoomDto> {
    return this.roomsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Удалить комнату',
    description:
      'Логическое удаление: незавершённая конференция завершается, история конференций сохраняется.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'id комнаты' })
  @ApiNoContentResponse({ description: 'Комната удалена' })
  @ApiNotFoundResponse({
    description:
      'Комната не найдена, уже удалена или принадлежит другому пользователю',
  })
  @ApiUnauthorizedResponse({ description: UNAUTHORIZED })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.roomsService.remove(user.id, id);
  }
}
