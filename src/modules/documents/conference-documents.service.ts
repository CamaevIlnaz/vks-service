import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConferenceStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { ConferenceActor } from '../conferences/conference.types.js';
import { ConferencesService } from '../conferences/conferences.service.js';
import { CollaborationService } from './collaboration/collaboration.service.js';
import { AttachDocumentDto } from './dto/attach-document.dto.js';
import {
  ConferenceDocumentDto,
  ConferenceDocumentListDto,
} from './dto/conference-document.dto.js';
import { ConferenceDocumentListQueryDto } from './dto/conference-document-list-query.dto.js';

const withTitle = {
  document: { select: { title: true } },
} satisfies Prisma.ConferenceDocumentInclude;

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class ConferenceDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conferencesService: ConferencesService,
    private readonly collaboration: CollaborationService,
  ) {}

  async list(
    conferenceId: string,
    actor: ConferenceActor,
    query: ConferenceDocumentListQueryDto,
  ): Promise<ConferenceDocumentListDto> {
    await this.conferencesService.getAccess(conferenceId, actor);

    const where: Prisma.ConferenceDocumentWhereInput = {
      conferenceId,
      ...(query.editedOnly ? { firstEditedAt: { not: null } } : {}),
    };
    const [total, links] = await this.prisma.$transaction([
      this.prisma.conferenceDocument.count({ where }),
      this.prisma.conferenceDocument.findMany({
        where,
        include: withTitle,
        orderBy: [{ attachedAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: links.map((link) => ConferenceDocumentDto.fromEntity(link)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async attach(
    conferenceId: string,
    actor: ConferenceActor,
    dto: AttachDocumentDto,
  ): Promise<ConferenceDocumentDto> {
    const access = await this.conferencesService.getAccess(conferenceId, actor);

    this.assertMutable(access.conference.status, conferenceId);
    this.conferencesService.assertModerator(access);

    try {
      const link = await this.prisma.$transaction(async (tx) => {
        const [conference] = await tx.$queryRaw<
          Array<{ status: ConferenceStatus; roomId: string }>
        >`
          SELECT "status", "roomId" FROM "Conference"
          WHERE "id" = ${conferenceId}::uuid
          FOR SHARE
        `;

        if (!conference || conference.status === ConferenceStatus.ENDED) {
          throw new ConflictException('Конференция завершена');
        }

        const document = await tx.roomDocument.findFirst({
          where: {
            id: dto.documentId,
            roomId: conference.roomId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!document) {
          throw new NotFoundException('Документ не найден');
        }

        return tx.conferenceDocument.create({
          data: { conferenceId, documentId: document.id },
          include: withTitle,
        });
      });

      return ConferenceDocumentDto.fromEntity(link);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Документ уже прикреплён к конференции');
      }

      throw error;
    }
  }

  async detach(
    conferenceId: string,
    documentId: string,
    actor: ConferenceActor,
  ): Promise<void> {
    const access = await this.conferencesService.getAccess(conferenceId, actor);

    this.assertMutable(access.conference.status, conferenceId);
    this.conferencesService.assertModerator(access);

    const link = await this.prisma.conferenceDocument.findUnique({
      where: {
        conferenceId_documentId: { conferenceId, documentId },
      },
      select: { id: true },
    });

    if (!link) {
      throw new NotFoundException('Документ не прикреплён к конференции');
    }

    await this.collaboration.disconnectDocument(documentId, conferenceId);
    await this.prisma.conferenceDocument.deleteMany({
      where: {
        id: link.id,
        conference: { status: { not: ConferenceStatus.ENDED } },
      },
    });
  }

  private assertMutable(status: ConferenceStatus, conferenceId: string): void {
    if (
      status === ConferenceStatus.ENDED ||
      this.collaboration.isSealed(conferenceId)
    ) {
      throw new ConflictException('Конференция завершена');
    }
  }
}
