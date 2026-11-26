import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class AddRoomMemberDto {
  @ApiProperty({
    example: 2,
    description:
      'id зарегистрированного пользователя. Владельца комнаты добавлять не нужно',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;
}
