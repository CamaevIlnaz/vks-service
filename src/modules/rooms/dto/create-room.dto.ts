import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { RoomAccessType } from '../../../generated/prisma/client.js';
import { SLUG_PATTERN } from '../room-access.js';

export const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const normalizeSlug = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateRoomDto {
  @ApiProperty({ example: 'Планёрка команды', maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 'team-standup',
    minLength: 3,
    maxLength: 64,
    pattern: SLUG_PATTERN.source,
    description:
      'Ссылка комнаты: латиница в нижнем регистре, цифры и дефисы. Если не указана — генерируется случайная.',
  })
  @Transform(normalizeSlug)
  @IsOptional()
  @IsString()
  @Length(3, 64)
  @Matches(SLUG_PATTERN, {
    message: 'slug может содержать только a-z, 0-9 и одиночные дефисы',
  })
  slug?: string;

  @ApiPropertyOptional({
    enum: RoomAccessType,
    enumName: 'RoomAccessType',
    default: RoomAccessType.OPEN,
    description:
      'OPEN — вход по ссылке для всех, включая гостей. CLOSED — только владелец и пользователи из списка допуска',
  })
  @IsOptional()
  @IsEnum(RoomAccessType)
  accessType?: RoomAccessType;
}
