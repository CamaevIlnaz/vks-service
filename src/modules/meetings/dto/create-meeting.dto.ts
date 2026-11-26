import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { trimString } from '../../rooms/dto/create-room.dto.js';
import { IsAfterInstant, IsMeetingInstant } from '../meeting-time.js';

export const MEETING_TITLE_MAX_LENGTH = 200;
export const MEETING_DESCRIPTION_MAX_LENGTH = 2000;
export const MEETING_ATTENDEE_LIMIT = 100;

export const trimOptionalText = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
};

export class CreateMeetingDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Комната, в которой пройдёт встреча',
  })
  @IsUUID('all', { message: 'roomId должен быть UUID' })
  roomId: string;

  @ApiProperty({ example: 'Планёрка', maxLength: MEETING_TITLE_MAX_LENGTH })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty({ message: 'Название встречи обязательно' })
  @MaxLength(MEETING_TITLE_MAX_LENGTH)
  title: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MEETING_DESCRIPTION_MAX_LENGTH,
    example: 'Обсудим итоги спринта',
  })
  @Transform(trimOptionalText)
  @IsOptional()
  @IsString()
  @MaxLength(MEETING_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @ApiProperty({
    example: '2027-03-01T10:00:00Z',
    format: 'date-time',
    description: 'Начало встречи, ISO 8601 с часовым поясом. Хранится в UTC',
  })
  @IsMeetingInstant()
  startsAt: string;

  @ApiProperty({
    example: '2027-03-01T11:00:00Z',
    format: 'date-time',
    description:
      'Окончание встречи, ISO 8601 с часовым поясом. Должно быть позже startsAt',
  })
  @IsMeetingInstant()
  @IsAfterInstant('startsAt', 'endsAt должен быть позже startsAt')
  endsAt: string;

  @ApiProperty({
    type: [Number],
    example: [2, 3],
    maxItems: MEETING_ATTENDEE_LIMIT,
    description:
      'Идентификаторы приглашённых пользователей. Организатор берётся из сессии и в этот список не входит. ' +
      'Для открытой комнаты — любые активные пользователи, для закрытой — только владелец и участники комнаты',
  })
  @IsArray()
  @ArrayUnique({ message: 'attendeeIds не должен содержать повторяющиеся id' })
  @ArrayMaxSize(MEETING_ATTENDEE_LIMIT, {
    message: `Можно пригласить не больше ${MEETING_ATTENDEE_LIMIT} пользователей`,
  })
  @IsInt({ each: true })
  @Min(1, { each: true })
  attendeeIds: number[];
}
