import {
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Room, RoomStatus, RoomType } from '../../generated/prisma/client.js';

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TEMPORARY_ROOM_TTL_MS = 24 * 60 * 60_000;

export const CLOSED_ROOM_FORBIDDEN =
  'Комната закрыта: подключиться могут только организатор и добавленные участники';

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

/** Поля комнаты, по которым решается, можно ли к ней подключиться. */
export type RoomJoinTarget = Pick<
  Room,
  | 'id'
  | 'ownerId'
  | 'accessType'
  | 'deletedAt'
  | 'status'
  | 'type'
  | 'expiresAt'
>;

/**
 * Комната удалена, завершена или у временной комнаты истёк срок.
 * Состав участников здесь не проверяется: это делает `RoomAccessService`.
 */
export function getAvailabilityError(
  room: Pick<RoomJoinTarget, 'deletedAt' | 'status' | 'type' | 'expiresAt'>,
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

  return null;
}

/**
 * `null` — открытая комната, список допуска не ограничивает вход.
 * Иначе id пользователей, которым можно подключаться: владелец и записи `room_members`.
 */
export function isAllowedByList(
  userId: number | null,
  allowList: Set<number> | null,
): boolean {
  if (allowList === null) {
    return true;
  }

  return userId !== null && allowList.has(userId);
}
