import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';

function toBoolean({ value }: { value: unknown }): unknown {
  if (value === undefined || value === '') {
    return false;
  }

  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  return value;
}

export class ConferenceDocumentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'true — только документы, содержимое которых меняли на этой конференции (firstEditedAt задан)',
  })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  editedOnly: boolean = false;
}
