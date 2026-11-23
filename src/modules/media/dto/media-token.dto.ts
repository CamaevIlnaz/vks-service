import { ApiProperty } from '@nestjs/swagger';

export class MediaTokenDto {
  @ApiProperty({
    example: 'ws://localhost:7880',
    description: 'WebSocket-адрес LiveKit для клиентского SDK',
  })
  url: string;

  @ApiProperty({
    description:
      'Короткоживущий LiveKit JWT. В логах сервера не появляется. Повторный запрос выдаёт новый токен и ничего не создаёт в БД.',
  })
  token: string;

  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty({ format: 'uuid' })
  participantId: string;

  @ApiProperty({ format: 'uuid' })
  sessionId: string;
}
