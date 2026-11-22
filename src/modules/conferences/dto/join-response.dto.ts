import { ApiProperty } from '@nestjs/swagger';
import {
  ConferenceParticipantRole,
  ConferenceStatus,
} from '../../../generated/prisma/client.js';
import { PublicRoomDto } from '../../rooms/dto/public-room.dto.js';

export class JoinResponseDto {
  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  conferenceStatus: ConferenceStatus;

  @ApiProperty({
    format: 'uuid',
    description: 'Один и тот же для всех устройств участника',
  })
  participantId: string;

  @ApiProperty({
    enum: ConferenceParticipantRole,
    enumName: 'ConferenceParticipantRole',
  })
  role: ConferenceParticipantRole;

  @ApiProperty({
    format: 'uuid',
    description: 'Подключение с текущего устройства, нужно для выхода',
  })
  sessionId: string;

  @ApiProperty({ type: PublicRoomDto })
  room: PublicRoomDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Только для гостя: подписанный токен, который нужно передавать в заголовке X-Guest-Token. Действует 24 часа.',
  })
  guestToken: string | null;
}
