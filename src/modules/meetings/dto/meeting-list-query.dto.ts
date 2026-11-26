import { ApiPropertyOptional } from '@nestjs/swagger';
import { ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { IsAfterInstant, IsMeetingInstant } from '../meeting-time.js';

export class MeetingListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2027-03-01T00:00:00Z',
    description:
      'Нижняя граница периода, ISO 8601 с часовым поясом. ' +
      'Встреча попадает в выборку, если ещё не закончилась к этому моменту (endsAt > from). ' +
      'В query символ + кодируется как %2B',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsMeetingInstant()
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    example: '2027-04-01T00:00:00Z',
    description:
      'Верхняя граница периода, ISO 8601 с часовым поясом. ' +
      'Встреча попадает в выборку, если началась раньше этого момента (startsAt < to). ' +
      'Вместе с from это пересечение интервалов. to должен быть позже from',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsMeetingInstant()
  @IsAfterInstant('from', 'to должен быть позже from')
  to?: string;
}
