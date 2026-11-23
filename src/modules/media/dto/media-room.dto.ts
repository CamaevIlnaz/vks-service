import { ApiProperty } from '@nestjs/swagger';

export class MediaParticipantDto {
  @ApiProperty({ description: 'LiveKit identity, равна id подключения' })
  identity: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'ACTIVE' })
  state: string;
}

export class MediaRoomInfoDto {
  @ApiProperty({ description: 'Имя медиакомнаты — id конференции' })
  name: string;

  @ApiProperty()
  sid: string;

  @ApiProperty()
  numParticipants: number;
}

export class MediaRoomDto {
  @ApiProperty({ example: 'ws://localhost:7880' })
  url: string;

  @ApiProperty({ format: 'uuid' })
  conferenceId: string;

  @ApiProperty({
    type: MediaRoomInfoDto,
    nullable: true,
    description: 'null, пока в комнату никто не подключался по WebRTC',
  })
  room: MediaRoomInfoDto | null;

  @ApiProperty({ type: [MediaParticipantDto] })
  participants: MediaParticipantDto[];
}
