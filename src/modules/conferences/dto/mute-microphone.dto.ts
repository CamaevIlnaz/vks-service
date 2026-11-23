import { ApiProperty } from '@nestjs/swagger';

export class MutedMicrophoneDto {
  @ApiProperty({ format: 'uuid' })
  sessionId: string;

  @ApiProperty({
    description:
      'Микрофон этого устройства запрещён. Другие устройства участника не затрагиваются. Ограничение проверяется заново при каждом медиатокене.',
  })
  microphoneMuted: true;
}
