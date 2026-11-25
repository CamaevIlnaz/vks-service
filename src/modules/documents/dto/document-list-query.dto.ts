import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { trimString } from '../../rooms/dto/create-room.dto.js';

export const DOCUMENT_SORT_FIELDS = [
  'title',
  'createdAt',
  'updatedAt',
] as const;

export type DocumentSortField = (typeof DOCUMENT_SORT_FIELDS)[number];

export class DocumentListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Поиск по названию, без учёта регистра',
    example: 'протокол',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: DOCUMENT_SORT_FIELDS,
    default: 'updatedAt',
  })
  @IsOptional()
  @IsIn(DOCUMENT_SORT_FIELDS)
  sortBy: DocumentSortField = 'updatedAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';
}
