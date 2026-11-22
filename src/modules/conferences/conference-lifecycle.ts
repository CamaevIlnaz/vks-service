import {
  Conference,
  ConferenceStatus,
  Prisma,
  Room,
  RoomStatus,
  RoomType,
} from '../../generated/prisma/client.js';

export const UNFINISHED_CONFERENCE_STATUSES = [
  ConferenceStatus.ACTIVE,
  ConferenceStatus.EMPTY,
];

export const EMPTY_CONFERENCE_TTL_MS = 3 * 60_000;

/**
 * Все переходы статусов конференций и комнаты выполняются под блокировкой строки комнаты:
 * подключение, выход, завершение, автозавершение и удаление комнаты не могут пересечься.
 */
export async function lockRoom(
  tx: Prisma.TransactionClient,
  roomId: string,
): Promise<Room | null> {
  await tx.$queryRaw`SELECT 1 FROM "Room" WHERE "id" = ${roomId}::uuid FOR UPDATE`;

  return tx.room.findUnique({ where: { id: roomId } });
}

/**
 * Вызывать только под `lockRoom`. Закрывает указанные подключения конференции;
 * если незакрытых подключений не осталось, переводит ACTIVE-конференцию в EMPTY.
 */
export async function closeSessions(
  tx: Prisma.TransactionClient,
  conferenceId: string,
  sessionIds: string[],
  now: Date,
): Promise<{ closed: number; conference: Conference; emptied: boolean }> {
  const { count } = await tx.conferenceParticipantSession.updateMany({
    where: {
      id: { in: sessionIds },
      leftAt: null,
      participant: { conferenceId },
    },
    data: { leftAt: now },
  });
  let conference = await tx.conference.findUniqueOrThrow({
    where: { id: conferenceId },
  });
  let emptied = false;

  if (count > 0 && conference.status === ConferenceStatus.ACTIVE) {
    const activeSessions = await tx.conferenceParticipantSession.count({
      where: { leftAt: null, participant: { conferenceId } },
    });

    if (activeSessions === 0) {
      conference = await tx.conference.update({
        where: { id: conferenceId },
        data: { status: ConferenceStatus.EMPTY, emptyAt: now },
      });
      emptied = true;
    }
  }

  return { closed: count, conference, emptied };
}

/** Вызывать только под `lockRoom`. Возвращает false, если конференция уже завершена. */
export async function finishConference(
  tx: Prisma.TransactionClient,
  conferenceId: string,
  room: Pick<Room, 'id' | 'type'>,
  now: Date,
): Promise<boolean> {
  const { count } = await tx.conference.updateMany({
    where: {
      id: conferenceId,
      status: { in: UNFINISHED_CONFERENCE_STATUSES },
    },
    data: { status: ConferenceStatus.ENDED, endedAt: now },
  });

  if (count === 0) {
    return false;
  }

  await tx.conferenceParticipantSession.updateMany({
    where: { leftAt: null, participant: { conferenceId } },
    data: { leftAt: now },
  });

  if (room.type === RoomType.TEMPORARY) {
    await tx.room.updateMany({
      where: { id: room.id, status: RoomStatus.ACTIVE },
      data: { status: RoomStatus.ENDED, endedAt: now },
    });
  }

  return true;
}
