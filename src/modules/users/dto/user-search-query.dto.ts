import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto.js';
import { trimString } from '../../rooms/dto/create-room.dto.js';

export class UserSearchQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: 'Часть имени или email, без учёта регистра',
    example: 'мария',
    maxLength: 200,
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  search: string;
}
