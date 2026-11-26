import { Body, Controller, Get, Patch, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { readAvatar } from './avatar-file.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UserSearchQueryDto } from './dto/user-search-query.dto.js';
import { UserDto, UserListDto } from './dto/user.dto.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary: 'Найти зарегистрированных пользователей',
    description:
      'Поиск по имени и email среди активных учётных записей. Нужен, чтобы владелец комнаты выбрал, кого добавить.',
  })
  @ApiOkResponse({ type: UserListDto })
  @ApiBadRequestResponse({
    description: 'Пустая строка поиска или некорректная пагинация',
  })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  search(@Query() query: UserSearchQueryDto): Promise<UserListDto> {
    return this.usersService.search(query);
  }

  @Get('me')
  @ApiOperation({ summary: 'Профиль текущего пользователя' })
  @ApiOkResponse({ type: UserDto })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  async getMe(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return UserDto.fromEntity(await this.usersService.getById(user.id));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Изменить профиль текущего пользователя' })
  @ApiOkResponse({ type: UserDto })
  @ApiBadRequestResponse({ description: 'Некорректные поля профиля' })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateUserDto,
  ): Promise<UserDto> {
    return UserDto.fromEntity(await this.usersService.update(user.id, dto));
  }

  @Patch('me/avatar')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Загрузить аватар текущего пользователя' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
          description: 'Изображение JPEG, PNG, WEBP или GIF до 2 МБ',
        },
      },
    },
  })
  @ApiOkResponse({ type: UserDto })
  @ApiBadRequestResponse({
    description: 'Файл не передан или это не изображение',
  })
  @ApiPayloadTooLargeResponse({ description: 'Файл аватара больше 2 МБ' })
  @ApiUnauthorizedResponse({
    description: 'Нет или недействителен access token',
  })
  async updateAvatar(
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ): Promise<UserDto> {
    const file = await readAvatar(request);
    return UserDto.fromEntity(
      await this.usersService.updateAvatar(user.id, file),
    );
  }
}
