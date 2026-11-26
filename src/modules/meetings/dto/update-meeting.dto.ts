import { ApiPropertyOptional } from '@nestjs/swagger';
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
  ValidateIf,
} from 'class-validator';
import { trimString } from '../../rooms/dto/create-room.dto.js';
import { IsAfterInstant, IsMeetingInstant } from '../meeting-time.js';
import {
  MEETING_ATTENDEE_LIMIT,
  MEETING_DESCRIPTION_MAX_LENGTH,
  MEETING_TITLE_MAX_LENGTH,
  trimOptionalText,
} from './create-meeting.dto.js';

export class UpdateMeetingDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Новая комната. Право управления расписанием и список приглашённых проверяются заново',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('all', { message: 'roomId должен быть UUID' })
  roomId?: string;

  @ApiPropertyOptional({
    example: 'Планёрка',
    maxLength: MEETING_TITLE_MAX_LENGTH,
  })
  @Transform(trimString)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'Название встречи обязательно' })
  @MaxLength(MEETING_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MEETING_DESCRIPTION_MAX_LENGTH,
    description: 'Пустая строка и null очищают описание',
  })
  @Transform(trimOptionalText)
  @IsOptional()
  @IsString()
  @MaxLength(MEETING_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({
    example: '2027-03-01T10:00:00Z',
    format: 'date-time',
    description: 'ISO 8601 с часовым поясом. Хранится в UTC',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsMeetingInstant()
  startsAt?: string;

  @ApiPropertyOptional({
    example: '2027-03-01T11:00:00Z',
    format: 'date-time',
    description:
      'ISO 8601 с часовым поясом. Если в запросе есть startsAt, endsAt должен быть позже него',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsMeetingInstant()
  @IsAfterInstant('startsAt', 'endsAt должен быть позже startsAt')
  endsAt?: string;

  @ApiPropertyOptional({
    type: [Number],
    example: [2, 3],
    maxItems: MEETING_ATTENDEE_LIMIT,
    description:
      'Новый список приглашённых. Заменяет предыдущий. Состав проверяется по правилам текущей или новой комнаты',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayUnique({ message: 'attendeeIds не должен содержать повторяющиеся id' })
  @ArrayMaxSize(MEETING_ATTENDEE_LIMIT, {
    message: `Можно пригласить не больше ${MEETING_ATTENDEE_LIMIT} пользователей`,
  })
  @IsInt({ each: true })
  @Min(1, { each: true })
  attendeeIds?: number[];
}
