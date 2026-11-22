import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { normalizeSlug } from '../../rooms/dto/create-room.dto.js';
import { SLUG_PATTERN } from '../../rooms/room-access.js';
import { JoinRoomDto } from './join-room.dto.js';

/** Payload WebSocket-события `conference:join`. */
export class JoinConferenceDto extends JoinRoomDto {
  @ApiProperty({ example: 'team-standup', pattern: SLUG_PATTERN.source })
  @Transform(normalizeSlug)
  @IsString()
  @Length(3, 64)
  @Matches(SLUG_PATTERN, { message: 'Некорректная ссылка комнаты' })
  slug: string;
}
