import { ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { Prisma, RoomAccessType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CLOSED_ROOM_FORBIDDEN,
  getAvailabilityError,
  isAllowedByList,
  type RoomJoinTarget,
} from './room-access.js';

type MemberReader = PrismaService | Prisma.TransactionClient;

/**
 * Единая проверка, можно ли подключиться к комнате.
 * Ссылка на закрытую комнату сама по себе права не даёт.
 * OPEN пускает всех, включая гостей. CLOSED — только владельца и пользователей из `room_members`.
 */
@Injectable()
export class RoomAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getJoinError(
    room: RoomJoinTarget,
    userId: number | null,
    hasUnfinishedConference: boolean,
    now: Date = new Date(),
    db: MemberReader = this.prisma,
  ): Promise<HttpException | null> {
    const availability = getAvailabilityError(
      room,
      hasUnfinishedConference,
      now,
    );

    if (availability) {
      return availability;
    }

    const allowList = await this.closedAllowList(room, db);

    if (isAllowedByList(userId, allowList)) {
      return null;
    }

    return new ForbiddenException(CLOSED_ROOM_FORBIDDEN);
  }

  /**
   * Список допуска закрытой комнаты в той же транзакции, что и изменение состава.
   * Для открытой комнаты возвращает null и не читает `room_members`.
   */
  async closedAllowList(
    room: Pick<RoomJoinTarget, 'id' | 'ownerId' | 'accessType'>,
    db: MemberReader = this.prisma,
  ): Promise<Set<number> | null> {
    if (room.accessType !== RoomAccessType.CLOSED) {
      return null;
    }

    const members = await db.roomMember.findMany({
      where: { roomId: room.id },
      select: { userId: true },
    });

    return new Set([room.ownerId, ...members.map((member) => member.userId)]);
  }
}
