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
import { CreateQuickRoomDto } from './dto/create-quick-room.dto.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { PublicRoomDto } from './dto/public-room.dto.js';
import { RoomDto, RoomListDto } from './dto/room.dto.js';
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
  @ApiOperation({ summary: 'Комнаты текущего пользователя' })
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

  @Patch(':id')
  @ApiOperation({
    summary: 'Изменить название, ссылку или тип доступа комнаты',
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
