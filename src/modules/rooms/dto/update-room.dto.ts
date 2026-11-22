import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { normalizeSlug, trimString } from './create-room.dto.js';

export class UpdateRoomDto {
  @ApiPropertyOptional({ example: 'Планёрка команды', maxLength: 100 })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    example: 'team-standup',
    minLength: 3,
    maxLength: 64,
    pattern: SLUG_PATTERN.source,
  })
  @Transform(normalizeSlug)
  @IsOptional()
  @IsString()
  @Length(3, 64)
  @Matches(SLUG_PATTERN, {
    message: 'slug может содержать только a-z, 0-9 и одиночные дефисы',
  })
  slug?: string;

  @ApiPropertyOptional({ enum: RoomAccessType, enumName: 'RoomAccessType' })
  @IsOptional()
  @IsEnum(RoomAccessType)
  accessType?: RoomAccessType;
}
