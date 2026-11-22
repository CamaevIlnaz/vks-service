import { ApiProperty } from '@nestjs/swagger';
import {
  Conference,
  ConferenceParticipantRole,
  ConferenceStatus,
} from '../../../generated/prisma/client.js';
import {
  participantDisplayName,
  type ParticipantWithUser,
} from './participant.dto.js';

/** Участник онлайн: несколько устройств одного участника — одна запись. */
export class ConferenceStateParticipantDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: Number, nullable: true })
  userId: number | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  guestId: string | null;

  @ApiProperty({ example: 'Иван Иванов' })
  name: string;

  @ApiProperty({
    enum: ConferenceParticipantRole,
    enumName: 'ConferenceParticipantRole',
  })
  role: ConferenceParticipantRole;

  @ApiProperty({ description: 'Число активных WebSocket-подключений' })
  connectionsCount: number;

  static fromEntity(
    participant: ParticipantWithUser,
    connectionsCount: number,
  ): ConferenceStateParticipantDto {
    return {
      id: participant.id,
      userId: participant.userId,
      guestId: participant.guestId,
      name: participantDisplayName(participant),
      role: participant.role,
      connectionsCount,
    };
  }
}

export class ConferenceStateDto {
  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty({ format: 'uuid' })
  roomId: string;

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  status: ConferenceStatus;

  @ApiProperty({ type: [ConferenceStateParticipantDto] })
  participants: ConferenceStateParticipantDto[];

  @ApiProperty()
  participantsCount: number;

  static fromEntity(
    conference: Conference,
    participants: ConferenceStateParticipantDto[],
  ): ConferenceStateDto {
    return {
      conferenceId: conference.id,
      roomId: conference.roomId,
      status: conference.status,
      participants,
      participantsCount: participants.length,
    };
  }
}
