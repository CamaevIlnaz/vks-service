import { ApiProperty } from '@nestjs/swagger';
import { ConferenceMessage } from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';
import {
  participantDisplayName,
  type ParticipantWithUser,
} from './participant.dto.js';

export class MessageAuthorDto {
  @ApiProperty({ format: 'uuid' })
  participantId: string;

  @ApiProperty({ example: 'Иван Иванов' })
  displayName: string;

  @ApiProperty({ type: String, nullable: true })
  avatarUrl: string | null;

  @ApiProperty()
  isGuest: boolean;
}

export class MessageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Всем привет!' })
  content: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: MessageAuthorDto })
  author: MessageAuthorDto;

  @ApiProperty({
    description: 'Сообщение отправлено текущим пользователем или гостем',
  })
  isMine: boolean;

  static fromEntity(
    message: ConferenceMessage & { participant: ParticipantWithUser },
    myParticipantId: string | null,
  ): MessageDto {
    return {
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      author: {
        participantId: message.participantId,
        displayName: participantDisplayName(message.participant),
        avatarUrl: message.participant.user?.avatarUrl ?? null,
        isGuest: message.participant.userId === null,
      },
      isMine: message.participantId === myParticipantId,
    };
  }
}

export class MessageListDto extends PaginatedDto {
  @ApiProperty({ type: [MessageDto], description: 'От новых к старым' })
  items: MessageDto[];
}
