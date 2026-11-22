import { ApiProperty } from '@nestjs/swagger';
import { ConferenceStatus } from '../../../generated/prisma/client.js';

export class LeaveResponseDto {
  @ApiProperty({ format: 'uuid' })
  sessionId: string;

  @ApiProperty({ type: String, format: 'date-time' })
  leftAt: Date;

  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty({ enum: ConferenceStatus, enumName: 'ConferenceStatus' })
  conferenceStatus: ConferenceStatus;
}
