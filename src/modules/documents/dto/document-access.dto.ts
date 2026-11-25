import { ApiProperty } from '@nestjs/swagger';

export class DocumentAccessDto {
  @ApiProperty({
    description:
      'Короткий токен Hocuspocus. Роли и права в него не кладутся: сервер проверяет их заново при подключении',
  })
  token: string;

  @ApiProperty({
    example: 'document:3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Постоянное имя Yjs-документа, без привязки к конференции',
  })
  documentName: string;

  @ApiProperty({ example: 'ws://127.0.0.1:1234' })
  url: string;

  @ApiProperty({
    example: 300,
    description:
      'Срок действия токена в секундах. Уже открытое соединение живёт, пока доступ не отозван',
  })
  expiresIn: number;
}
