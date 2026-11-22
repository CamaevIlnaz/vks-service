import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ConferenceStatus,
  RoomStatus,
  RoomType,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EMPTY_CONFERENCE_TTL_MS,
  finishConference,
  lockRoom,
  UNFINISHED_CONFERENCE_STATUSES,
} from './conference-lifecycle.js';

const BATCH_SIZE = 100;

@Injectable()
export class ConferencesScheduler {
  private readonly logger = new Logger(ConferencesScheduler.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleTick(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.finishEmptyConferences();
      await this.expireTemporaryRooms();
    } catch (error) {
      this.logger.error('Ошибка периодической проверки конференций', error);
    } finally {
      this.running = false;
    }
  }

  /** Конференция в EMPTY дольше 3 минут завершается. Статус перепроверяется под блокировкой комнаты. */
  async finishEmptyConferences(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - EMPTY_CONFERENCE_TTL_MS);
    const candidates = await this.prisma.conference.findMany({
      where: { status: ConferenceStatus.EMPTY, emptyAt: { lte: threshold } },
      select: { id: true, roomId: true },
      orderBy: { emptyAt: 'asc' },
      take: BATCH_SIZE,
    });
    let finished = 0;

    for (const candidate of candidates) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const room = await lockRoom(tx, candidate.roomId);
          const conference = await tx.conference.findUnique({
            where: { id: candidate.id },
          });

          if (
            !room ||
            conference?.status !== ConferenceStatus.EMPTY ||
            !conference.emptyAt ||
            conference.emptyAt > threshold
          ) {
            return false;
          }

          return finishConference(tx, conference.id, room, new Date());
        });

        if (done) {
          finished += 1;
        }
      } catch (error) {
        this.logger.error(
          `Не удалось завершить конференцию ${candidate.id}`,
          error,
        );
      }
    }

    return finished;
  }

  /** Временная комната, в которой так и не началась конференция до expiresAt, завершается. */
  async expireTemporaryRooms(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.room.updateMany({
      where: {
        type: RoomType.TEMPORARY,
        status: RoomStatus.ACTIVE,
        expiresAt: { lte: now },
        conferences: {
          none: { status: { in: UNFINISHED_CONFERENCE_STATUSES } },
        },
      },
      data: { status: RoomStatus.ENDED, endedAt: now },
    });

    return count;
  }
}
