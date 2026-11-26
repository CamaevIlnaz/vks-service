import { ApiProperty } from '@nestjs/swagger';
import {
  Conference,
  ConferenceStatus,
  Room,
  RoomAccessType,
  RoomStatus,
  RoomType,
} from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

export class RoomConferenceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  status: ConferenceStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emptyAt: Date | null;
}

/** Комната, которой пользователь владеет или в которую его добавили. */
export class RoomDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

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

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Для временной комнаты: после этого момента новую конференцию начать нельзя',
  })
  expiresAt: Date | null;

  @ApiProperty({
    type: RoomConferenceDto,
    nullable: true,
    description: 'Незавершённая конференция (ACTIVE или EMPTY)',
  })
  activeConference: RoomConferenceDto | null;

  static fromEntity(room: Room & { conferences: Conference[] }): RoomDto {
    const [conference] = room.conferences;

    return {
      id: room.id,
      name: room.name,
      slug: room.slug,
      type: room.type,
      accessType: room.accessType,
      status: room.status,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      endedAt: room.endedAt,
      expiresAt: room.expiresAt,
      activeConference: conference
        ? {
            id: conference.id,
            status: conference.status,
            startedAt: conference.startedAt,
            emptyAt: conference.emptyAt,
          }
        : null,
    };
  }
}

export class RoomListDto extends PaginatedDto {
  @ApiProperty({ type: [RoomDto] })
  items: RoomDto[];
}
