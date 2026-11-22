import { ApiProperty } from '@nestjs/swagger';

/** Метаданные страницы. Списочные DTO наследуют его и добавляют `items`. */
export class PaginatedDto {
  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;
}
