import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Room,
  RoomAccessType,
  RoomStatus,
  RoomType,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferenceEventsService } from '../conferences/conference-events.service.js';
import {
  ConferencesService,
  type RevokedRoomAccess,
} from '../conferences/conferences.service.js';
import {
  closeSessions,
  finishConference,
  lockRoom,
  UNFINISHED_CONFERENCE_STATUSES,
} from '../conferences/conference-lifecycle.js';
import { ConferencePresenceService } from '../conferences/conference-presence.service.js';
import { CollaborationService } from '../documents/collaboration/collaboration.service.js';
import { AddRoomMemberDto } from './dto/add-room-member.dto.js';
import { CreateQuickRoomDto } from './dto/create-quick-room.dto.js';
import { CreateRoomDto } from './dto/create-room.dto.js';
import { PublicRoomDto } from './dto/public-room.dto.js';
import { RoomDto, RoomListDto } from './dto/room.dto.js';
import { RoomMemberDto, RoomMemberListDto } from './dto/room-member.dto.js';
import { UpdateRoomDto } from './dto/update-room.dto.js';
import {
  generateSlug,
  isAllowedByList,
  TEMPORARY_ROOM_TTL_MS,
} from './room-access.js';
import { RoomAccessService } from './room-access.service.js';

const SLUG_GENERATION_ATTEMPTS = 5;

const memberUserSelect = {
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
} satisfies Prisma.RoomMemberInclude;

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
    private readonly roomAccess: RoomAccessService,
    private readonly conferences: ConferencesService,
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

  async list(userId: number, query: PaginationQueryDto): Promise<RoomListDto> {
    const where: Prisma.RoomWhereInput = {
      deletedAt: null,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    };
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
      (await this.roomAccess.getJoinError(
        room,
        userId,
        hasActiveConference,
      )) === null,
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

    if (
      dto.accessType === RoomAccessType.CLOSED &&
      room.accessType !== RoomAccessType.CLOSED
    ) {
      return this.restrictAccess(ownerId, id, changes);
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

  async listMembers(
    ownerId: number,
    roomId: string,
    query: PaginationQueryDto,
  ): Promise<RoomMemberListDto> {
    await this.getOwned(ownerId, roomId);

    const where: Prisma.RoomMemberWhereInput = { roomId };
    const [total, members] = await this.prisma.$transaction([
      this.prisma.roomMember.count({ where }),
      this.prisma.roomMember.findMany({
        where,
        include: memberUserSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: members.map((member) => RoomMemberDto.fromEntity(member)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async addMember(
    ownerId: number,
    roomId: string,
    dto: AddRoomMemberDto,
  ): Promise<RoomMemberDto> {
    const member = await this.presence.withRoomLock(roomId, () =>
      this.prisma.$transaction(async (tx) => {
        const room = await this.lockOwnedRoom(tx, ownerId, roomId);

        if (dto.userId === room.ownerId) {
          throw new BadRequestException('Владелец комнаты уже имеет доступ');
        }

        const user = await tx.user.findUnique({
          where: { id: dto.userId },
          select: { id: true, status: true },
        });

        if (!user) {
          throw new NotFoundException('Пользователь не найден');
        }

        if (user.status !== UserStatus.ACTIVE) {
          throw new BadRequestException('Учётная запись недоступна');
        }

        try {
          return await tx.roomMember.create({
            data: { roomId, userId: dto.userId, addedById: ownerId },
            include: memberUserSelect,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException('Пользователь уже добавлен в комнату');
          }

          throw error;
        }
      }),
    );

    return RoomMemberDto.fromEntity(member);
  }

  /**
   * Удаляет допуск. В закрытой комнате сразу закрывает активные сессии этого
   * пользователя: сокеты, LiveKit и редактирование. История участия остаётся.
   */
  async removeMember(
    ownerId: number,
    roomId: string,
    userId: number,
  ): Promise<void> {
    await this.presence.withRoomLock(roomId, async () => {
      const revoked = await this.prisma.$transaction(async (tx) => {
        const room = await this.lockOwnedRoom(tx, ownerId, roomId);
        const removed = await tx.roomMember.deleteMany({
          where: { roomId, userId },
        });

        if (removed.count === 0) {
          throw new NotFoundException('Пользователь не найден в комнате');
        }

        return this.closeUnauthorizedSessions(tx, room, userId);
      });

      await this.conferences.notifyAccessRevoked(revoked);
    });
  }

  /**
   * Переход OPEN → CLOSED под блокировкой комнаты: параллельный вход либо
   * успевает до смены типа, либо уже видит закрытую комнату.
   * После фиксации отключаются гости и пользователи не из списка допуска.
   */
  private async restrictAccess(
    ownerId: number,
    id: string,
    changes: Prisma.RoomUpdateInput,
  ): Promise<RoomDto> {
    await this.presence.withRoomLock(id, async () => {
      const revoked = await this.prisma.$transaction(async (tx) => {
        const current = await this.lockOwnedRoom(tx, ownerId, id);

        let updated: Room;

        try {
          updated = await tx.room.update({ where: { id }, data: changes });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ConflictException('Ссылка уже занята');
          }

          throw error;
        }

        if (
          current.accessType === RoomAccessType.CLOSED ||
          updated.accessType !== RoomAccessType.CLOSED
        ) {
          return null;
        }

        return this.closeUnauthorizedSessions(tx, updated);
      });

      await this.conferences.notifyAccessRevoked(revoked);
    });

    return this.getOwned(ownerId, id);
  }

  private async lockOwnedRoom(
    tx: Prisma.TransactionClient,
    ownerId: number,
    roomId: string,
  ): Promise<Room> {
    const room = await lockRoom(tx, roomId);

    if (!room || room.ownerId !== ownerId || room.deletedAt) {
      throw new NotFoundException('Комната не найдена');
    }

    if (room.status === RoomStatus.ENDED) {
      throw new ConflictException('Завершённую комнату изменить нельзя');
    }

    return room;
  }

  /**
   * Закрывает сессии тех, кому по уже сохранённому состоянию комнаты нельзя
   * оставаться. `onlyUserId` ограничивает отзыв одним пользователем.
   * Записи участников и сообщения не удаляются.
   */
  private async closeUnauthorizedSessions(
    tx: Prisma.TransactionClient,
    room: Room,
    onlyUserId?: number,
  ): Promise<RevokedRoomAccess | null> {
    const conference = await tx.conference.findFirst({
      where: {
        roomId: room.id,
        status: { in: UNFINISHED_CONFERENCE_STATUSES },
      },
    });

    if (!conference) {
      return null;
    }

    const sessions = await tx.conferenceParticipantSession.findMany({
      where: {
        leftAt: null,
        participant: {
          conferenceId: conference.id,
          ...(onlyUserId !== undefined ? { userId: onlyUserId } : {}),
        },
      },
      select: {
        id: true,
        participantId: true,
        participant: { select: { userId: true } },
      },
    });
    const allowList = await this.roomAccess.closedAllowList(room, tx);
    const denied = sessions.filter(
      (session) => !isAllowedByList(session.participant.userId, allowList),
    );

    if (denied.length === 0) {
      return null;
    }

    const result = await closeSessions(
      tx,
      conference.id,
      denied.map((session) => session.id),
      new Date(),
    );

    return {
      conferenceId: conference.id,
      sessionIds: denied.map((session) => session.id),
      participantIds: [
        ...new Set(denied.map((session) => session.participantId)),
      ],
      conference: result.conference,
      emptied: result.emptied,
    };
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
