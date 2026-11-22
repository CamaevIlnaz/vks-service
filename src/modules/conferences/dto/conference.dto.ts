import { ApiProperty } from '@nestjs/swagger';
import {
  Conference,
  ConferenceStatus,
  Room,
  RoomType,
} from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

export class ConferenceSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  status: ConferenceStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emptyAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;

  @ApiProperty({ description: 'Уникальные участники без учёта устройств' })
  participantsCount: number;

  static fromEntity(
    conference: Conference,
    participantsCount: number,
  ): ConferenceSummaryDto {
    return {
      id: conference.id,
      status: conference.status,
      startedAt: conference.startedAt,
      emptyAt: conference.emptyAt,
      endedAt: conference.endedAt,
      participantsCount,
    };
  }
}

export class ConferenceRoomDto {
  @ApiProperty({ example: 'Планёрка команды' })
  name: string;

  @ApiProperty({ example: 'team-standup' })
  slug: string;

  @ApiProperty({ enum: RoomType, enumName: 'RoomType' })
  type: RoomType;
}

export class ConferenceDto extends ConferenceSummaryDto {
  @ApiProperty({
    description:
      'Участники, у которых есть незакрытое подключение. Это не гарантия присутствия онлайн: закрытие вкладки без выхода не фиксируется.',
  })
  activeParticipantsCount: number;

  @ApiProperty({ type: ConferenceRoomDto })
  room: ConferenceRoomDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Участник, соответствующий текущему пользователю или гостю',
  })
  myParticipantId: string | null;

  @ApiProperty({
    description: 'Текущий пользователь — организатор (владелец комнаты)',
  })
  isOrganizer: boolean;

  static fromDetails(
    conference: Conference & { room: Room },
    counts: { participants: number; activeParticipants: number },
    myParticipantId: string | null,
    isOrganizer: boolean,
  ): ConferenceDto {
    return {
      ...ConferenceSummaryDto.fromEntity(conference, counts.participants),
      activeParticipantsCount: counts.activeParticipants,
      room: {
        name: conference.room.name,
        slug: conference.room.slug,
        type: conference.room.type,
      },
      myParticipantId,
      isOrganizer,
    };
  }
}

export class ConferenceListDto extends PaginatedDto {
  @ApiProperty({ type: [ConferenceSummaryDto] })
  items: ConferenceSummaryDto[];
}
