import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { closeSessions, lockRoom } from './conference-lifecycle.js';

const BATCH_SIZE = 500;

@Injectable()
export class ConferenceSessionsService {
  private readonly logger = new Logger(ConferenceSessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Немедленно закрывает подключения отозванных сессий авторизации. Не бросает ошибок: пропущенное закроет планировщик. */
  async closeForAuthSessions(
    authSession: Prisma.AuthSessionWhereInput,
  ): Promise<void> {
    try {
      await this.closeWhere({ authSession }, new Date());
    } catch (error) {
      this.logger.error(
        'Не удалось закрыть подключения отозванной сессии',
        error,
      );
    }
  }

  /**
   * Подключения пользователей, у которых сессия авторизации отозвана, истекла или удалена,
   * либо учётная запись заблокирована. Подключения гостей не затрагиваются.
   */
  closeUnauthorized(now: Date = new Date()): Promise<number> {
    return this.closeWhere(
      {
        participant: { userId: { not: null } },
        OR: [
          { authSessionId: null },
          { authSession: { revokedAt: { not: null } } },
          { authSession: { expiresAt: { lte: now } } },
          {
            participant: { user: { status: { not: UserStatus.ACTIVE } } },
          },
        ],
      },
      now,
    );
  }

  private async closeWhere(
    where: Prisma.ConferenceParticipantSessionWhereInput,
    now: Date,
  ): Promise<number> {
    const sessions = await this.prisma.conferenceParticipantSession.findMany({
      where: { AND: [where, { leftAt: null }] },
      select: {
        id: true,
        participant: {
          select: {
            conferenceId: true,
            conference: { select: { roomId: true } },
          },
        },
      },
      take: BATCH_SIZE,
    });
    const byConference = new Map<string, { roomId: string; ids: string[] }>();

    for (const session of sessions) {
      const { conferenceId, conference } = session.participant;
      const group = byConference.get(conferenceId) ?? {
        roomId: conference.roomId,
        ids: [],
      };
      group.ids.push(session.id);
      byConference.set(conferenceId, group);
    }

    let closed = 0;

    for (const [conferenceId, { roomId, ids }] of byConference) {
      try {
        closed += await this.prisma.$transaction(async (tx) => {
          await lockRoom(tx, roomId);
          const result = await closeSessions(tx, conferenceId, ids, now);

          return result.closed;
        });
      } catch (error) {
        this.logger.error(
          `Не удалось закрыть подключения конференции ${conferenceId}`,
          error,
        );
      }
    }

    return closed;
  }
}
