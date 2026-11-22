import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { RoomAccessType } from '../../../generated/prisma/client.js';

export class CreateQuickRoomDto {
  @ApiPropertyOptional({
    enum: RoomAccessType,
    enumName: 'RoomAccessType',
    default: RoomAccessType.OPEN,
  })
  @IsOptional()
  @IsEnum(RoomAccessType)
  accessType?: RoomAccessType;
}
