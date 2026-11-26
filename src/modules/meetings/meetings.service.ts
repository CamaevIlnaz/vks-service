import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ConferenceStatus,
  Prisma,
  RoomAccessType,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  getAvailabilityError,
  isAllowedByList,
  type RoomJoinTarget,
} from '../rooms/room-access.js';
import { RoomAccessService } from '../rooms/room-access.service.js';
import { CreateMeetingDto } from './dto/create-meeting.dto.js';
import { MeetingListQueryDto } from './dto/meeting-list-query.dto.js';
import { MeetingDto, MeetingListDto } from './dto/meeting.dto.js';
import { UpdateMeetingDto } from './dto/update-meeting.dto.js';
import { isMeetingInstant } from './meeting-time.js';

const meetingUserSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const scheduleRoomSelect = {
  id: true,
  name: true,
  slug: true,
  ownerId: true,
  accessType: true,
  deletedAt: true,
  status: true,
  type: true,
  expiresAt: true,
} satisfies Prisma.RoomSelect;

const meetingInclude = {
  room: { select: scheduleRoomSelect },
  organizer: { select: meetingUserSelect },
  attendees: {
    select: {
      userId: true,
      user: { select: meetingUserSelect },
    },
  },
} satisfies Prisma.MeetingInclude;

type ScheduleRoom = Prisma.RoomGetPayload<{
  select: typeof scheduleRoomSelect;
}>;
type MeetingView = Prisma.MeetingGetPayload<{ include: typeof meetingInclude }>;
type MeetingDb = Prisma.TransactionClient | PrismaService;

/**
 * Планирование встреч.
 * Встреча связана только с комнатой и приглашёнными и не создаёт конференцию.
 * Приглашение не добавляет пользователя в room_members и не меняет правила подключения.
 */
@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roomAccess: RoomAccessService,
  ) {}

  async list(
    userId: number,
    query: MeetingListQueryDto,
  ): Promise<MeetingListDto> {
    const from = query.from ? this.instant(query.from) : undefined;
    const to = query.to ? this.instant(query.to) : undefined;

    if (from && to && to.getTime() <= from.getTime()) {
      throw new BadRequestException('to должен быть позже from');
    }

    const where = this.visibleMeetingsWhere(userId, from, to);
    const [total, meetings] = await this.prisma.$transaction([
      this.prisma.meeting.count({ where }),
      this.prisma.meeting.findMany({
        where,
        include: meetingInclude,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: meetings.map((meeting) => MeetingDto.fromEntity(meeting)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getOne(userId: number, id: string): Promise<MeetingDto> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: meetingInclude,
    });

    if (!meeting || meeting.room.deletedAt) {
      throw new NotFoundException('Встреча не найдена');
    }

    await this.assertCanView(this.prisma, meeting, userId);

    return MeetingDto.fromEntity(meeting);
  }

  async create(
    organizerId: number,
    dto: CreateMeetingDto,
  ): Promise<MeetingDto> {
    const startsAt = this.instant(dto.startsAt);
    const endsAt = this.instant(dto.endsAt);
    this.assertInterval(startsAt, endsAt);

    try {
      const meeting = await this.prisma.$transaction(async (tx) => {
        const room = await this.lockManagedRoom(
          tx,
          dto.roomId,
          organizerId,
          'hide',
        );
        await this.assertRoomAvailable(tx, room);
        await this.assertAttendees(tx, room, dto.attendeeIds, organizerId);

        return tx.meeting.create({
          data: {
            roomId: room.id,
            organizerId,
            title: dto.title,
            description: dto.description ?? null,
            startsAt,
            endsAt,
            ...(dto.attendeeIds.length > 0
              ? {
                  attendees: {
                    create: dto.attendeeIds.map((userId) => ({ userId })),
                  },
                }
              : {}),
          },
          include: meetingInclude,
        });
      });

      return MeetingDto.fromEntity(meeting);
    } catch (error) {
      throw this.normalizeWriteError(error);
    }
  }

  async update(
    userId: number,
    id: string,
    dto: UpdateMeetingDto,
  ): Promise<MeetingDto> {
    if (!this.hasChanges(dto)) {
      throw new BadRequestException('Не указаны поля для обновления');
    }

    try {
      const meeting = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "meetings" WHERE "id" = ${id}::uuid FOR UPDATE`;

        const current = await tx.meeting.findUnique({
          where: { id },
          include: meetingInclude,
        });

        if (!current || current.room.deletedAt) {
          throw new NotFoundException('Встреча не найдена');
        }

        await this.assertCanView(tx, current, userId);

        if (current.organizerId !== userId) {
          throw new ForbiddenException(
            'Изменять встречу может только организатор',
          );
        }

        const startsAt = dto.startsAt
          ? this.instant(dto.startsAt)
          : current.startsAt;
        const endsAt = dto.endsAt ? this.instant(dto.endsAt) : current.endsAt;
        this.assertInterval(startsAt, endsAt);

        const roomChanges =
          dto.roomId !== undefined && dto.roomId !== current.roomId;
        const attendeesChange = dto.attendeeIds !== undefined;
        let room: ScheduleRoom = current.room;

        if (roomChanges) {
          room = await this.lockManagedRoom(tx, dto.roomId!, userId, 'hide');
          await this.assertRoomAvailable(tx, room);
        } else if (attendeesChange) {
          room = await this.lockManagedRoom(
            tx,
            current.roomId,
            userId,
            'forbid',
          );
        }

        if (roomChanges || attendeesChange) {
          await this.assertAttendees(
            tx,
            room,
            dto.attendeeIds ??
              current.attendees.map((attendee) => attendee.userId),
            current.organizerId,
          );
        }

        const data: Prisma.MeetingUncheckedUpdateInput = {
          roomId: room.id,
          startsAt,
          endsAt,
        };

        if (dto.title !== undefined) {
          data.title = dto.title;
        }

        if (dto.description !== undefined) {
          data.description = dto.description;
        }

        await tx.meeting.update({ where: { id }, data });

        if (attendeesChange) {
          await tx.meetingAttendee.deleteMany({ where: { meetingId: id } });

          if (dto.attendeeIds && dto.attendeeIds.length > 0) {
            await tx.meetingAttendee.createMany({
              data: dto.attendeeIds.map((attendeeId) => ({
                meetingId: id,
                userId: attendeeId,
              })),
            });
          }
        }

        return tx.meeting.findUniqueOrThrow({
          where: { id },
          include: meetingInclude,
        });
      });

      return MeetingDto.fromEntity(meeting);
    } catch (error) {
      throw this.normalizeWriteError(error);
    }
  }

  async remove(userId: number, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "meetings" WHERE "id" = ${id}::uuid FOR UPDATE`;

      const meeting = await tx.meeting.findUnique({
        where: { id },
        include: meetingInclude,
      });

      if (!meeting || meeting.room.deletedAt) {
        throw new NotFoundException('Встреча не найдена');
      }

      await this.assertCanView(tx, meeting, userId);

      if (meeting.organizerId !== userId) {
        throw new ForbiddenException(
          'Удалять встречу может только организатор',
        );
      }

      await tx.meeting.delete({ where: { id } });
    });
  }

  /**
   * Организатор или приглашённый. В закрытой комнате пользователь ещё должен
   * входить в список допуска: удаление из room_members доступ к встречам закрывает.
   */
  private async assertCanView(
    db: MeetingDb,
    meeting: Pick<MeetingView, 'organizerId' | 'attendees' | 'room'>,
    userId: number,
  ): Promise<void> {
    const participates =
      meeting.organizerId === userId ||
      meeting.attendees.some((attendee) => attendee.userId === userId);

    if (!participates) {
      throw new NotFoundException('Встреча не найдена');
    }

    const allowList = await this.roomAccess.closedAllowList(meeting.room, db);

    if (!isAllowedByList(userId, allowList)) {
      throw new NotFoundException('Встреча не найдена');
    }
  }

  private async lockManagedRoom(
    tx: Prisma.TransactionClient,
    roomId: string,
    userId: number,
    denial: 'hide' | 'forbid',
  ): Promise<ScheduleRoom> {
    await tx.$queryRaw`SELECT 1 FROM "Room" WHERE "id" = ${roomId}::uuid FOR UPDATE`;

    const room = await tx.room.findUnique({
      where: { id: roomId },
      select: scheduleRoomSelect,
    });

    if (
      room &&
      room.deletedAt === null &&
      this.roomAccess.canManageSchedule(room, userId)
    ) {
      return room;
    }

    if (denial === 'forbid' && room && room.deletedAt === null) {
      throw new ForbiddenException(
        'Нет права управлять расписанием этой комнаты',
      );
    }

    throw new NotFoundException(
      denial === 'forbid' ? 'Встреча не найдена' : 'Комната не найдена',
    );
  }

  /** Та же доступность, что у входа в комнату: удалённая, завершённая или истёкшая временная. */
  private async assertRoomAvailable(
    tx: Prisma.TransactionClient,
    room: ScheduleRoom,
  ): Promise<void> {
    const unfinished = await tx.conference.findFirst({
      where: {
        roomId: room.id,
        status: { in: [ConferenceStatus.ACTIVE, ConferenceStatus.EMPTY] },
      },
      select: { id: true },
    });
    const availabilityError = getAvailabilityError(room, unfinished !== null);

    if (availabilityError) {
      throw availabilityError;
    }
  }

  private async assertAttendees(
    db: MeetingDb,
    room: Pick<RoomJoinTarget, 'id' | 'ownerId' | 'accessType'>,
    attendeeIds: number[],
    organizerId: number,
  ): Promise<void> {
    if (new Set(attendeeIds).size !== attendeeIds.length) {
      throw new BadRequestException(
        'attendeeIds не должен содержать повторяющиеся id',
      );
    }

    if (attendeeIds.includes(organizerId)) {
      throw new BadRequestException(
        'Организатор уже участвует во встрече и не указывается в списке приглашённых',
      );
    }

    if (attendeeIds.length === 0) {
      return;
    }

    const users = await db.user.findMany({
      where: { id: { in: attendeeIds } },
      select: { id: true, status: true },
    });

    if (users.length !== attendeeIds.length) {
      throw new NotFoundException('Приглашённый пользователь не найден');
    }

    if (users.some((user) => user.status !== UserStatus.ACTIVE)) {
      throw new BadRequestException(
        'Пригласить можно только пользователей с активной учётной записью',
      );
    }

    const allowList = await this.roomAccess.closedAllowList(room, db);

    if (
      allowList &&
      attendeeIds.some((attendeeId) => !allowList.has(attendeeId))
    ) {
      throw new BadRequestException(
        'В закрытую комнату можно приглашать только владельца и участников комнаты',
      );
    }
  }

  /**
   * Встречи, где пользователь организатор или приглашённый.
   * Период — пересечение [startsAt, endsAt) с [from, to).
   * Закрытая комната видна только пока пользователь в списке допуска.
   */
  private visibleMeetingsWhere(
    userId: number,
    from?: Date,
    to?: Date,
  ): Prisma.MeetingWhereInput {
    const filters: Prisma.MeetingWhereInput[] = [
      {
        OR: [{ organizerId: userId }, { attendees: { some: { userId } } }],
      },
      {
        room: {
          deletedAt: null,
          OR: [
            { accessType: RoomAccessType.OPEN },
            { ownerId: userId },
            { members: { some: { userId } } },
          ],
        },
      },
    ];

    if (from) {
      filters.push({ endsAt: { gt: from } });
    }

    if (to) {
      filters.push({ startsAt: { lt: to } });
    }

    return { AND: filters };
  }

  private hasChanges(dto: UpdateMeetingDto): boolean {
    return (
      dto.roomId !== undefined ||
      dto.title !== undefined ||
      dto.description !== undefined ||
      dto.startsAt !== undefined ||
      dto.endsAt !== undefined ||
      dto.attendeeIds !== undefined
    );
  }

  private assertInterval(startsAt: Date, endsAt: Date): void {
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt должен быть позже startsAt');
    }
  }

  private instant(value: string): Date {
    if (!isMeetingInstant(value)) {
      throw new BadRequestException(
        'Дата должна быть в ISO 8601 с часовым поясом',
      );
    }

    return new Date(value);
  }

  private normalizeWriteError(error: unknown): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2003'
    ) {
      return new NotFoundException('Приглашённый пользователь не найден');
    }

    return error;
  }
}
