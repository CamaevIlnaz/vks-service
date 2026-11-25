import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RoomAccessType,
  RoomStatus,
  RoomType,
} from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferenceEventsService } from '../conferences/conference-events.service.js';
import {
  finishConference,
  lockRoom,
  UNFINISHED_CONFERENCE_STATUSES,
} from '../conferences/conference-lifecycle.js';
import { ConferencePresenceService } from '../conferences/conference-presence.service.js';
import { CollaborationService } from '../documents/collaboration/collaboration.service.js';
import { CreateQuickRoomDto } from './dto/create-quick-room.dto.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { PublicRoomDto } from './dto/public-room.dto.js';
import { RoomDto, RoomListDto } from './dto/room.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import {
  generateSlug,
  getJoinError,
  TEMPORARY_ROOM_TTL_MS,
} from './room-access.js';

const SLUG_GENERATION_ATTEMPTS = 5;

const withActiveConference = {
  conferences: {
    where: { status: { in: UNFINISHED_CONFERENCE_STATUSES } },
    take: 1,
  },
} satisfies Prisma.RoomInclude;

type RoomCreateData = Omit<Prisma.RoomUncheckedCreateInput, 'slug'>;

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: ConferencePresenceService,
    private readonly events: ConferenceEventsService,
    private readonly collaboration: CollaborationService,
  ) {}

  async create(ownerId: number, dto: CreateRoomDto): Promise<RoomDto> {
    const data: RoomCreateData = {
      ownerId,
      name: dto.name,
      type: RoomType.PERMANENT,
      accessType: dto.accessType ?? RoomAccessType.OPEN,
    };

    if (!dto.slug) {
      return this.createWithRandomSlug(data);
    }

    try {
      const room = await this.prisma.room.create({
        data: { ...data, slug: dto.slug },
        include: withActiveConference,
      });

      return RoomDto.fromEntity(room);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Ссылка уже занята');
      }
      throw error;
    }
  }

  createQuick(ownerId: number, dto: CreateQuickRoomDto): Promise<RoomDto> {
    return this.createWithRandomSlug(
      {
        ownerId,
        type: RoomType.TEMPORARY,
        accessType: dto.accessType ?? RoomAccessType.OPEN,
        expiresAt: new Date(Date.now() + TEMPORARY_ROOM_TTL_MS),
      },
      (slug) => `Встреча ${slug}`,
    );
  }

  async list(ownerId: number, query: PaginationQueryDto): Promise<RoomListDto> {
    const where: Prisma.RoomWhereInput = { ownerId, deletedAt: null };
    const [total, rooms] = await this.prisma.$transaction([
      this.prisma.room.count({ where }),
      this.prisma.room.findMany({
        where,
        include: withActiveConference,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: rooms.map((room) => RoomDto.fromEntity(room)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getOwned(ownerId: number, id: string): Promise<RoomDto> {
    const room = await this.prisma.room.findFirst({
      where: { id, ownerId, deletedAt: null },
      include: withActiveConference,
    });

    if (!room) {
      throw new NotFoundException('Комната не найдена');
    }

    return RoomDto.fromEntity(room);
  }

  async getPublicBySlug(
    slug: string,
    userId: number | null,
  ): Promise<PublicRoomDto> {
    const room = await this.prisma.room.findFirst({
      where: { slug: slug.toLowerCase(), deletedAt: null },
      include: withActiveConference,
    });

    if (!room) {
      throw new NotFoundException('Комната не найдена');
    }

    const hasActiveConference = room.conferences.length > 0;

    return PublicRoomDto.fromEntity(
      room,
      hasActiveConference,
      getJoinError(room, userId, hasActiveConference) === null,
    );
  }

  async update(
    ownerId: number,
    id: string,
    dto: UpdateRoomDto,
  ): Promise<RoomDto> {
    const changes: Prisma.RoomUpdateInput = {};

    if (dto.name !== undefined) {
      changes.name = dto.name;
    }
    if (dto.slug !== undefined) {
      changes.slug = dto.slug;
    }
    if (dto.accessType !== undefined) {
      changes.accessType = dto.accessType;
    }

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('Не указаны поля для обновления');
    }

    const room = await this.getOwned(ownerId, id);

    if (room.status === RoomStatus.ENDED) {
      throw new ConflictException('Завершённую комнату изменить нельзя');
    }

    try {
      const updated = await this.prisma.room.update({
        where: { id, deletedAt: null },
        data: changes,
        include: withActiveConference,
      });

      return RoomDto.fromEntity(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Ссылка уже занята');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Комната не найдена');
      }
      throw error;
    }
  }

  /** Комната помечается удалённой, незавершённая конференция завершается, история остаётся. */
  async remove(ownerId: number, id: string): Promise<void> {
    await this.presence.withRoomLock(id, async () => {
      const now = new Date();
      const room = await this.prisma.room.findUnique({ where: { id } });

      if (!room || room.ownerId !== ownerId || room.deletedAt) {
        throw new NotFoundException('Комната не найдена');
      }

      const unfinished = await this.prisma.conference.findFirst({
        where: {
          roomId: id,
          status: { in: UNFINISHED_CONFERENCE_STATUSES },
        },
        select: { id: true },
      });
      const finishRoom = () =>
        this.prisma.$transaction(async (tx) => {
          const locked = await lockRoom(tx, id);

          if (!locked || locked.ownerId !== ownerId || locked.deletedAt) {
            throw new NotFoundException('Комната не найдена');
          }

          const conference = await tx.conference.findFirst({
            where: {
              roomId: id,
              status: { in: UNFINISHED_CONFERENCE_STATUSES },
            },
          });
          const finished =
            conference !== null &&
            (await finishConference(tx, conference.id, locked, now));

          await tx.room.update({ where: { id }, data: { deletedAt: now } });

          return finished ? conference.id : null;
        });
      const finishedConferenceId = unfinished
        ? await this.collaboration.withConferenceSeal(
            unfinished.id,
            finishRoom,
            (conferenceId) => conferenceId !== null,
          )
        : await finishRoom();

      if (finishedConferenceId) {
        await this.events.conferenceEnded(finishedConferenceId, now);
      }
    });
  }

  private async createWithRandomSlug(
    data: Omit<RoomCreateData, 'name'> & { name?: string },
    nameFromSlug?: (slug: string) => string,
  ): Promise<RoomDto> {
    for (let attempt = 1; ; attempt += 1) {
      const slug = generateSlug();

      try {
        const room = await this.prisma.room.create({
          data: { ...data, name: data.name ?? nameFromSlug!(slug), slug },
          include: withActiveConference,
        });

        return RoomDto.fromEntity(room);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= SLUG_GENERATION_ATTEMPTS) {
          throw error;
        }
      }
    }
  }
}
