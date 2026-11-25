import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DocumentListQueryDto } from './dto/document-list-query.dto.js';
import { DocumentDto, DocumentListDto } from './dto/document.dto.js';
import { CreateDocumentDto } from './dto/create-document.dto.js';
import { UpdateDocumentDto } from './dto/update-document.dto.js';
import { CollaborationService } from './collaboration/collaboration.service.js';
import { emptyYjsState } from './collaboration/yjs-state.js';

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaboration: CollaborationService,
  ) {}

  async list(
    ownerId: number,
    roomId: string,
    query: DocumentListQueryDto,
  ): Promise<DocumentListDto> {
    await this.requireOwnedRoom(ownerId, roomId);

    const where: Prisma.RoomDocumentWhereInput = {
      roomId,
      deletedAt: null,
      ...(query.search
        ? { title: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };
    const orderBy: Prisma.RoomDocumentOrderByWithRelationInput[] = [
      { [query.sortBy]: query.sortOrder },
      { id: 'asc' },
    ];
    const [total, documents] = await this.prisma.$transaction([
      this.prisma.roomDocument.count({ where }),
      this.prisma.roomDocument.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: documents.map((document) => DocumentDto.fromEntity(document)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async create(
    ownerId: number,
    roomId: string,
    dto: CreateDocumentDto,
  ): Promise<DocumentDto> {
    await this.requireOwnedRoom(ownerId, roomId);

    const document = await this.prisma.roomDocument.create({
      data: {
        roomId,
        createdById: ownerId,
        title: dto.title,
        yjsState: emptyYjsState(),
      },
    });

    return DocumentDto.fromEntity(document);
  }

  async getOne(
    ownerId: number,
    roomId: string,
    documentId: string,
  ): Promise<DocumentDto> {
    await this.requireOwnedRoom(ownerId, roomId);

    const document = await this.findActive(roomId, documentId);

    return DocumentDto.fromEntity(document);
  }

  async rename(
    ownerId: number,
    roomId: string,
    documentId: string,
    dto: UpdateDocumentDto,
  ): Promise<DocumentDto> {
    await this.requireOwnedRoom(ownerId, roomId);
    await this.findActive(roomId, documentId);

    const document = await this.prisma.roomDocument.update({
      where: { id: documentId },
      data: { title: dto.title },
    });

    return DocumentDto.fromEntity(document);
  }

  /** Логическое удаление. История конференций сохраняет ссылку и название. */
  async remove(
    ownerId: number,
    roomId: string,
    documentId: string,
  ): Promise<void> {
    await this.requireOwnedRoom(ownerId, roomId);
    await this.findActive(roomId, documentId);
    await this.collaboration.disconnectDocument(documentId);
    await this.prisma.roomDocument.update({
      where: { id: documentId },
      data: { deletedAt: new Date() },
    });
  }

  private async requireOwnedRoom(
    ownerId: number,
    roomId: string,
  ): Promise<void> {
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, ownerId, deletedAt: null },
      select: { id: true },
    });

    if (!room) {
      throw new NotFoundException('Комната не найдена');
    }
  }

  private async findActive(roomId: string, documentId: string) {
    const document = await this.prisma.roomDocument.findFirst({
      where: { id: documentId, roomId, deletedAt: null },
    });

    if (!document) {
      throw new NotFoundException('Документ не найден');
    }

    return document;
  }
}
