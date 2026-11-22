import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Conference,
  ConferenceParticipant,
  ConferenceParticipantRole,
  ConferenceStatus,
  DeviceType,
  Prisma,
  Room,
} from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PublicRoomDto } from '../rooms/dto/public-room.dto.js';
import { getJoinError } from '../rooms/room-access.js';
import {
  closeSessions,
  finishConference,
  lockRoom,
  UNFINISHED_CONFERENCE_STATUSES,
} from './conference-lifecycle.js';
import type { ConferenceActor } from './conference.types.js';
import {
  ConferenceDto,
  ConferenceListDto,
  ConferenceSummaryDto,
} from './dto/conference.dto.js';
import { JoinResponseDto } from './dto/join-response.dto.js';
import { JoinRoomDto } from './dto/join-room.dto.js';
import { LeaveResponseDto } from './dto/leave-response.dto.js';
import { ParticipantDto, ParticipantListDto } from './dto/participant.dto.js';
import { GuestTokensService } from './guest-tokens.service.js';

export const participantUserSelect = {
  user: { select: { name: true, avatarUrl: true } },
} satisfies Prisma.ConferenceParticipantInclude;

type JoinIdentity =
  | { kind: 'user'; userId: number; authSessionId: string }
  | { kind: 'guest'; guestId: string; guestName: string };

export interface ConferenceAccess {
  conference: Conference & { room: Room };
  participant: ConferenceParticipant | null;
  isOrganizer: boolean;
}

export function detectDeviceType(userAgent: string | undefined): DeviceType {
  if (!userAgent) {
    return DeviceType.UNKNOWN;
  }
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(userAgent)) {
    return DeviceType.TABLET;
  }
  if (/mobi|iphone|ipod|android/i.test(userAgent)) {
    return DeviceType.MOBILE;
  }

  return DeviceType.DESKTOP;
}

@Injectable()
export class ConferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly guestTokensService: GuestTokensService,
  ) {}

  /**
   * Гость без токена или с недействительным токеном получает новый guestId.
   * Под блокировкой комнаты конференция находится или создаётся атомарно,
   * поэтому параллельные подключения не создадут вторую незавершённую конференцию.
   */
  async join(
    slug: string,
    user: Pick<AuthUser, 'id' | 'sessionId'> | null,
    guestToken: string | undefined,
    dto: JoinRoomDto,
    userAgent: string | undefined,
  ): Promise<JoinResponseDto> {
    let identity: JoinIdentity;

    if (user) {
      identity = {
        kind: 'user',
        userId: user.id,
        authSessionId: user.sessionId,
      };
    } else {
      if (!dto.guestName) {
        throw new BadRequestException('Гостю нужно указать имя');
      }

      const guestId =
        (guestToken && (await this.guestTokensService.verify(guestToken))) ||
        randomUUID();
      identity = { kind: 'guest', guestId, guestName: dto.guestName };
    }

    const roomRef = await this.prisma.room.findFirst({
      where: { slug: slug.toLowerCase(), deletedAt: null },
      select: { id: true },
    });

    if (!roomRef) {
      throw new NotFoundException('Комната не найдена');
    }

    const deviceType = dto.deviceType ?? detectDeviceType(userAgent);

    const { room, conference, participant, sessionId } =
      await this.prisma.$transaction(async (tx) => {
        const room = await lockRoom(tx, roomRef.id);

        if (!room) {
          throw new NotFoundException('Комната не найдена');
        }

        const now = new Date();
        let conference = await tx.conference.findFirst({
          where: {
            roomId: room.id,
            status: { in: UNFINISHED_CONFERENCE_STATUSES },
          },
        });
        const joinError = getJoinError(
          room,
          identity.kind === 'user' ? identity.userId : null,
          conference !== null,
          now,
        );

        if (joinError) {
          throw joinError;
        }

        if (!conference) {
          conference = await tx.conference.create({
            data: {
              roomId: room.id,
              status: ConferenceStatus.ACTIVE,
              startedAt: now,
            },
          });
        } else if (conference.status === ConferenceStatus.EMPTY) {
          conference = await tx.conference.update({
            where: { id: conference.id },
            data: { status: ConferenceStatus.ACTIVE, emptyAt: null },
          });
        }

        const participant = await this.findOrCreateParticipant(
          tx,
          conference.id,
          room,
          identity,
        );
        const session = await tx.conferenceParticipantSession.create({
          data: {
            participantId: participant.id,
            authSessionId:
              identity.kind === 'user' ? identity.authSessionId : null,
            deviceType,
            joinedAt: now,
          },
        });

        return { room, conference, participant, sessionId: session.id };
      });

    return {
      conferenceId: conference.id,
      conferenceStatus: conference.status,
      participantId: participant.id,
      role: participant.role,
      sessionId,
      room: PublicRoomDto.fromEntity(room, true, true),
      guestToken:
        identity.kind === 'guest'
          ? await this.guestTokensService.sign(identity.guestId)
          : null,
    };
  }

  /** Закрывает только указанное подключение. Повторный вызов возвращает текущее состояние. */
  async leave(
    sessionId: string,
    actor: ConferenceActor,
  ): Promise<LeaveResponseDto> {
    const session = await this.prisma.conferenceParticipantSession.findUnique({
      where: { id: sessionId },
      include: { participant: { include: { conference: true } } },
    });

    if (!session || !isActorParticipant(actor, session.participant)) {
      throw new NotFoundException('Подключение не найдено');
    }

    const { conference: initialConference } = session.participant;

    if (session.leftAt) {
      return {
        sessionId,
        leftAt: session.leftAt,
        conferenceId: initialConference.id,
        conferenceStatus: initialConference.status,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      await lockRoom(tx, initialConference.roomId);

      const { conference } = await closeSessions(
        tx,
        initialConference.id,
        [sessionId],
        new Date(),
      );
      const { leftAt } =
        await tx.conferenceParticipantSession.findUniqueOrThrow({
          where: { id: sessionId },
        });

      return {
        sessionId,
        leftAt: leftAt!,
        conferenceId: conference.id,
        conferenceStatus: conference.status,
      };
    });
  }

  /** Повторный вызов для уже завершённой конференции безопасен. */
  async end(conferenceId: string, userId: number): Promise<ConferenceDto> {
    const access = await this.getAccess(conferenceId, {
      kind: 'user',
      userId,
    });

    if (!access.isOrganizer) {
      throw new ForbiddenException(
        'Завершить конференцию может только организатор',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const room = await lockRoom(tx, access.conference.roomId);

      await finishConference(tx, conferenceId, room!, new Date());
    });

    return this.findOne(conferenceId, { kind: 'user', userId });
  }

  async findOne(
    conferenceId: string,
    actor: ConferenceActor,
  ): Promise<ConferenceDto> {
    const { conference, participant, isOrganizer } = await this.getAccess(
      conferenceId,
      actor,
    );
    const [participants, activeParticipants] = await this.prisma.$transaction([
      this.prisma.conferenceParticipant.count({ where: { conferenceId } }),
      this.prisma.conferenceParticipant.count({
        where: { conferenceId, sessions: { some: { leftAt: null } } },
      }),
    ]);

    return ConferenceDto.fromDetails(
      conference,
      { participants, activeParticipants },
      participant?.id ?? null,
      isOrganizer,
    );
  }

  async listParticipants(
    conferenceId: string,
    actor: ConferenceActor,
    query: PaginationQueryDto,
  ): Promise<ParticipantListDto> {
    const { participant: me } = await this.getAccess(conferenceId, actor);
    const where: Prisma.ConferenceParticipantWhereInput = { conferenceId };
    const [total, participants] = await this.prisma.$transaction([
      this.prisma.conferenceParticipant.count({ where }),
      this.prisma.conferenceParticipant.findMany({
        where,
        include: {
          ...participantUserSelect,
          _count: { select: { sessions: { where: { leftAt: null } } } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    return {
      items: participants.map((participant) =>
        ParticipantDto.fromEntity(
          participant,
          participant._count.sessions,
          me?.id ?? null,
        ),
      ),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Владелец видит всю историю комнаты (в том числе удалённой),
   * остальные пользователи — только конференции, в которых участвовали.
   */
  async listRoomHistory(
    roomId: string,
    userId: number,
    query: PaginationQueryDto,
  ): Promise<ConferenceListDto> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { ownerId: true },
    });

    if (!room) {
      throw new NotFoundException('Комната не найдена');
    }

    const isOwner = room.ownerId === userId;
    const where: Prisma.ConferenceWhereInput = isOwner
      ? { roomId }
      : { roomId, participants: { some: { userId } } };
    const [total, conferences] = await this.prisma.$transaction([
      this.prisma.conference.count({ where }),
      this.prisma.conference.findMany({
        where,
        include: { _count: { select: { participants: true } } },
        orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
    ]);

    if (!isOwner && total === 0) {
      throw new NotFoundException('Комната не найдена');
    }

    return {
      items: conferences.map((conference) =>
        ConferenceSummaryDto.fromEntity(
          conference,
          conference._count.participants,
        ),
      ),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Доступ к конференции есть у организатора и у её участников.
   * Гостям завершённые конференции недоступны. Без доступа — 404, чтобы не раскрывать существование.
   */
  async getAccess(
    conferenceId: string,
    actor: ConferenceActor,
  ): Promise<ConferenceAccess> {
    const conference = await this.prisma.conference.findUnique({
      where: { id: conferenceId },
      include: { room: true },
    });

    if (!conference) {
      throw new NotFoundException('Конференция не найдена');
    }

    const isOrganizer =
      actor.kind === 'user' && conference.room.ownerId === actor.userId;
    const participant = await this.prisma.conferenceParticipant.findFirst({
      where:
        actor.kind === 'user'
          ? { conferenceId, userId: actor.userId }
          : { conferenceId, guestId: actor.guestId },
    });

    if (!isOrganizer && !participant) {
      throw new NotFoundException('Конференция не найдена');
    }

    if (
      actor.kind === 'guest' &&
      conference.status === ConferenceStatus.ENDED
    ) {
      throw new ForbiddenException(
        'История завершённых конференций недоступна гостям',
      );
    }

    return { conference, participant, isOrganizer };
  }

  /** Вызывается под блокировкой комнаты, поэтому дубликат участника не создаётся. */
  private async findOrCreateParticipant(
    tx: Prisma.TransactionClient,
    conferenceId: string,
    room: Room,
    identity: JoinIdentity,
  ): Promise<ConferenceParticipant> {
    if (identity.kind === 'user') {
      const existing = await tx.conferenceParticipant.findFirst({
        where: { conferenceId, userId: identity.userId },
      });

      return (
        existing ??
        tx.conferenceParticipant.create({
          data: {
            conferenceId,
            userId: identity.userId,
            role:
              room.ownerId === identity.userId
                ? ConferenceParticipantRole.HOST
                : ConferenceParticipantRole.PARTICIPANT,
          },
        })
      );
    }

    const existing = await tx.conferenceParticipant.findFirst({
      where: { conferenceId, guestId: identity.guestId },
    });

    if (!existing) {
      return tx.conferenceParticipant.create({
        data: {
          conferenceId,
          guestId: identity.guestId,
          guestName: identity.guestName,
          role: ConferenceParticipantRole.PARTICIPANT,
        },
      });
    }

    if (existing.guestName === identity.guestName) {
      return existing;
    }

    return tx.conferenceParticipant.update({
      where: { id: existing.id },
      data: { guestName: identity.guestName },
    });
  }
}

function isActorParticipant(
  actor: ConferenceActor,
  participant: ConferenceParticipant,
): boolean {
  return actor.kind === 'user'
    ? participant.userId === actor.userId
    : participant.guestId === actor.guestId;
}
