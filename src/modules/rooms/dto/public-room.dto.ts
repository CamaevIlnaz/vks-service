import { ApiProperty } from '@nestjs/swagger';
import {
  Room,
  RoomAccessType,
  RoomStatus,
  RoomType,
} from '../../../generated/prisma/client.js';

/** Комната по ссылке: без id, владельца и прочих приватных данных. */
export class PublicRoomDto {
  @ApiProperty({ example: 'Планёрка команды' })
  name: string;

  @ApiProperty({ example: 'team-standup' })
  slug: string;

  @ApiProperty({ enum: RoomType, enumName: 'RoomType' })
  type: RoomType;

  @ApiProperty({ enum: RoomAccessType, enumName: 'RoomAccessType' })
  accessType: RoomAccessType;

  @ApiProperty({ enum: RoomStatus, enumName: 'RoomStatus' })
  status: RoomStatus;

  @ApiProperty({ description: 'В комнате идёт незавершённая конференция' })
  hasActiveConference: boolean;

  @ApiProperty({
    description: 'Может ли текущий пользователь или гость подключиться',
  })
  canJoin: boolean;

  static fromEntity(
    room: Room,
    hasActiveConference: boolean,
    canJoin: boolean,
  ): PublicRoomDto {
    return {
      name: room.name,
      slug: room.slug,
      type: room.type,
      accessType: room.accessType,
      status: room.status,
      hasActiveConference,
      canJoin,
    };
  }
}
