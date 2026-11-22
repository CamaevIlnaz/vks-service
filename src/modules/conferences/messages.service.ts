import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConferenceStatus, Prisma } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferenceEventsService } from './conference-events.service.js';
import type { ConferenceActor } from './conference.types.js';
import {
  ConferencesService,
  participantUserSelect,
} from './conferences.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { MessageDto, MessageListDto } from './dto/message.dto.js';

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conferencesService: ConferencesService,
    private readonly events: ConferenceEventsService,
  ) {}

  async list(
    conferenceId: string,
    actor: ConferenceActor,
    query: PaginationQueryDto,
  ): Promise<MessageListDto> {
    const { participant: me } = await this.conferencesService.getAccess(
      conferenceId,
      actor,
    );
    const where: Prisma.ConferenceMessageWhereInput = { conferenceId };
    const [total, messages] = await this.prisma.$transaction([
      this.prisma.conferenceMessage.count({ where }),
      this.prisma.conferenceMessage.findMany({
        where,
        include: { participant: { include: participantUserSelect } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: messages.map((message) =>
        MessageDto.fromEntity(message, me?.id ?? null),
      ),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async create(
    conferenceId: string,
    actor: ConferenceActor,
    dto: CreateMessageDto,
  ): Promise<MessageDto> {
    const { participant } = await this.conferencesService.getAccess(
      conferenceId,
      actor,
    );

    if (!participant) {
      throw new ForbiddenException(
        'Отправлять сообщения могут только участники конференции',
      );
    }

    const message = await this.prisma.$transaction(async (tx) => {
      // FOR SHARE не даёт завершить конференцию, пока сообщение не сохранено.
      const [conference] = await tx.$queryRaw<{ status: ConferenceStatus }[]>`
        SELECT "status" FROM "Conference" WHERE "id" = ${conferenceId}::uuid FOR SHARE`;

      if (conference?.status !== ConferenceStatus.ACTIVE) {
        throw new ConflictException('Конференция не активна');
      }

      const activeSessions = await tx.conferenceParticipantSession.count({
        where: { participantId: participant.id, leftAt: null },
      });

      if (activeSessions === 0) {
        throw new ForbiddenException('Нет активного подключения к конференции');
      }

      return tx.conferenceMessage.create({
        data: {
          conferenceId,
          participantId: participant.id,
          content: dto.content,
        },
        include: { participant: { include: participantUserSelect } },
      });
    });

    const created = MessageDto.fromEntity(message, participant.id);

    this.events.messageCreated(conferenceId, created);

    return created;
  }
}
