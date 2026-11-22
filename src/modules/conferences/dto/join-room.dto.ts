import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { DeviceType } from '../../../generated/prisma/client.js';
import { trimString } from '../../rooms/dto/create-room.dto.js';

export class JoinRoomDto {
  @ApiPropertyOptional({
    example: 'Гость Пётр',
    maxLength: 100,
    description:
      'Обязательно для гостя. Для авторизованного пользователя игнорируется — берётся имя из профиля.',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  guestName?: string;

  @ApiPropertyOptional({
    enum: DeviceType,
    enumName: 'DeviceType',
    description: 'Если не указан — определяется по User-Agent',
  })
  @IsOptional()
  @IsEnum(DeviceType)
  deviceType?: DeviceType;
}
