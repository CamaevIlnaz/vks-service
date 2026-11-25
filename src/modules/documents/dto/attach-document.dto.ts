import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AttachDocumentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Документ этой же комнаты. Копия не создаётся',
  })
  @IsUUID()
  documentId: string;
}
