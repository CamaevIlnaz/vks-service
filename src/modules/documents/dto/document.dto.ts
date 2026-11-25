import { ApiProperty } from '@nestjs/swagger';
import { RoomDocument } from '../../../generated/prisma/client.js';
import { PaginatedDto } from '../../../common/dto/paginated.dto.js';

/** Метаданные документа. Бинарное состояние Yjs отдаёт только Hocuspocus. */
export class DocumentDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  roomId: string;

  @ApiProperty({ example: 'Повестка' })
  title: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Пользователь, создавший документ. Пусто, если учётка удалена',
  })
  createdById: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  static fromEntity(document: RoomDocument): DocumentDto {
    return {
      id: document.id,
      roomId: document.roomId,
      title: document.title,
      createdById: document.createdById,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }
}

export class DocumentListDto extends PaginatedDto {
  @ApiProperty({ type: [DocumentDto] })
  items: DocumentDto[];
}
