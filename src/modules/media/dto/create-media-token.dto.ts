import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateMediaTokenDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'id уже открытого подключения (conference_participant_sessions). Новая конференция и сессия здесь не создаются.',
  })
  @IsUUID()
  sessionId: string;
}
