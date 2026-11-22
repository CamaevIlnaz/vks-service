import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { trimString } from '../../rooms/dto/create-room.dto.js';

export class CreateMessageDto {
  @ApiProperty({ example: 'Всем привет!', maxLength: 2000 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;
}
