import {
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  Room,
  RoomAccessType,
  RoomStatus,
  RoomType,
} from '../../generated/prisma/client.js';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEMPORARY_ROOM_TTL_MS = 24 * 60 * 60_000;

const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz';
const SLUG_GROUPS = [3, 4, 3];

/** Ссылка вида `abc-defg-hij`: 24^10 вариантов, подобрать чужую ссылку перебором нереально. */
export function generateSlug(): string {
  return SLUG_GROUPS.map((length) =>
    Array.from(
      { length },
      () => SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)],
    ).join(''),
  ).join('-');
}

/**
 * Причина, по которой пользователь (или гость при `userId = null`) не может подключиться.
 * Заявок на вступление в закрытую комнату пока нет, поэтому туда входит только владелец.
 */
export function getJoinError(
  room: Room,
  userId: number | null,
  hasUnfinishedConference: boolean,
  now: Date = new Date(),
): HttpException | null {
  if (room.deletedAt) {
    return new NotFoundException('Комната не найдена');
  }

  if (room.status === RoomStatus.ENDED) {
    return new GoneException('Комната завершена');
  }

  if (
    room.type === RoomType.TEMPORARY &&
    room.expiresAt &&
    room.expiresAt <= now &&
    !hasUnfinishedConference
  ) {
    return new GoneException('Срок действия комнаты истёк');
  }

  if (room.accessType === RoomAccessType.CLOSED && room.ownerId !== userId) {
    return new ForbiddenException(
      'Комната закрыта: подключиться может только организатор',
    );
  }

  return null;
}
