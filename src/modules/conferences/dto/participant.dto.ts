import { ApiProperty } from '@nestjs/swagger';
import {
  ConferenceParticipant,
  ConferenceParticipantRole,
  User,
} from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

export type ParticipantWithUser = ConferenceParticipant & {
  user: Pick<User, 'name' | 'avatarUrl'> | null;
};

export function participantDisplayName(
  participant: ParticipantWithUser,
): string {
  return participant.user?.name ?? participant.guestName ?? 'Гость';
}

/** userId и guestId наружу не отдаются. */
export class ParticipantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Иван Иванов' })
  displayName: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/uploads/avatars/1.png',
  })
  avatarUrl: string | null;

  @ApiProperty()
  isGuest: boolean;

  @ApiProperty({
    enum: ConferenceParticipantRole,
    enumName: 'ConferenceParticipantRole',
  })
  role: ConferenceParticipantRole;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Первое подключение',
  })
  joinedAt: Date;

  @ApiProperty({
    description:
      'Незакрытые подключения (устройства). Не гарантирует присутствие онлайн.',
  })
  activeSessionsCount: number;

  @ApiProperty({ description: 'Это текущий пользователь или гость' })
  isMe: boolean;

  static fromEntity(
    participant: ParticipantWithUser,
    activeSessionsCount: number,
    myParticipantId: string | null,
  ): ParticipantDto {
    return {
      id: participant.id,
      displayName: participantDisplayName(participant),
      avatarUrl: participant.user?.avatarUrl ?? null,
      isGuest: participant.userId === null,
      role: participant.role,
      joinedAt: participant.createdAt,
      activeSessionsCount,
      isMe: participant.id === myParticipantId,
    };
  }
}

export class ParticipantListDto extends PaginatedDto {
  @ApiProperty({ type: [ParticipantDto] })
  items: ParticipantDto[];
}
