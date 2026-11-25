import { ApiProperty } from '@nestjs/swagger';
import {
  ConferenceDocument,
  RoomDocument,
} from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

type ConferenceDocumentWithTitle = ConferenceDocument & {
  document: Pick<RoomDocument, 'title'>;
};

/** Связь конференции с документом комнаты. Это не снимок содержимого. */
export class ConferenceDocumentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty({ example: 'Повестка' })
  title: string;

  @ApiProperty({ type: String, format: 'date-time' })
  attachedAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Первое изменение содержимого на этой конференции',
  })
  firstEditedAt: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Последнее изменение содержимого на этой конференции',
  })
  lastEditedAt: Date | null;

  static fromEntity(link: ConferenceDocumentWithTitle): ConferenceDocumentDto {
    return {
      id: link.id,
      documentId: link.documentId,
      title: link.document.title,
      attachedAt: link.attachedAt,
      firstEditedAt: link.firstEditedAt,
      lastEditedAt: link.lastEditedAt,
    };
  }
}

export class ConferenceDocumentListDto extends PaginatedDto {
  @ApiProperty({ type: [ConferenceDocumentDto] })
  items: ConferenceDocumentDto[];
}
