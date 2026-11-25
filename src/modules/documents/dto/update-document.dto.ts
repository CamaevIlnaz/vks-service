import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trimString } from '../../rooms/dto/create-room.dto.js';

export class UpdateDocumentDto {
  @ApiProperty({ example: 'Протокол встречи', maxLength: 200 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;
}
