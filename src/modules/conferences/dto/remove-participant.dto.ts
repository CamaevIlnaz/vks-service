import { ApiProperty } from '@nestjs/swagger';
import { ConferenceStatus } from '../../../generated/prisma/client.js';

export class ParticipantRemovedDto {
  @ApiProperty({ format: 'uuid' })
  participantId: string;

  @ApiProperty({
    type: [String],
    description: 'Подключения, которые были закрыты этим вызовом',
  })
  closedSessionIds: string[];

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  conferenceStatus: ConferenceStatus;
}
