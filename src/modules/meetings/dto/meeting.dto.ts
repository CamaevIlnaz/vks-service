import { ApiProperty } from '@nestjs/swagger';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

export class MeetingUserDto {
  @ApiProperty({ example: 1 })
  id: number;

  @ApiProperty({ example: 'Иван Иванов' })
  name: string;

  @ApiProperty({ example: 'ivan@example.com' })
  email: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/uploads/avatars/1.png',
  })
  avatarUrl: string | null;
}

export class MeetingRoomDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Планёрка команды' })
  name: string;

  @ApiProperty({ example: 'team-standup' })
  slug: string;
}

interface MeetingUserSource {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface MeetingSource {
  id: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  updatedAt: Date;
  room: MeetingRoomDto;
  organizer: MeetingUserSource;
  attendees: { user: MeetingUserSource }[];
}

function toUser(user: MeetingUserSource): MeetingUserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  };
}

/** Встреча с комнатой, организатором и приглашёнными. Организатора в attendees нет. */
export class MeetingDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Планёрка' })
  title: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Обсудим итоги спринта',
  })
  description: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({ type: MeetingRoomDto })
  room: MeetingRoomDto;

  @ApiProperty({ type: MeetingUserDto })
  organizer: MeetingUserDto;

  @ApiProperty({ type: [MeetingUserDto] })
  attendees: MeetingUserDto[];

  static fromEntity(meeting: MeetingSource): MeetingDto {
    return {
      id: meeting.id,
      title: meeting.title,
      description: meeting.description,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      createdAt: meeting.createdAt,
      updatedAt: meeting.updatedAt,
      room: {
        id: meeting.room.id,
        name: meeting.room.name,
        slug: meeting.room.slug,
      },
      organizer: toUser(meeting.organizer),
      attendees: meeting.attendees
        .map((attendee) => toUser(attendee.user))
        .sort((left, right) => {
          const byName = left.name.localeCompare(right.name, 'ru');

          return byName === 0 ? left.id - right.id : byName;
        }),
    };
  }
}

export class MeetingListDto extends PaginatedDto {
  @ApiProperty({ type: [MeetingDto] })
  items: MeetingDto[];
}
