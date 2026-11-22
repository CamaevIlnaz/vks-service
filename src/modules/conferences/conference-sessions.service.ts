import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferenceEventsService } from './conference-events.service.js';
import { closeSessions, lockRoom } from './conference-lifecycle.js';
import { ConferencePresenceService } from './conference-presence.service.js';

const BATCH_SIZE = 500;

@Injectable()
export class ConferenceSessionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConferenceSessionsService.name);
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: ConferencePresenceService,
    private readonly events: ConferenceEventsService,
  ) {}

  /**
   * После перезапуска присутствие в памяти пустое, а онлайн определяется только по нему,
   * поэтому все подключения, открытые до старта процесса, считаются зависшими и закрываются.
   * Опустевшие конференции переходят в EMPTY и завершатся через 3 минуты, если никто не переподключится.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      let closed: number;
      let total = 0;

      do {
        closed = await this.closeWhere(
          { joinedAt: { lt: this.startedAt } },
          new Date(),
        );
        total += closed;
      } while (closed > 0);

      if (total > 0) {
        this.logger.log(`Закрыто зависших подключений: ${total}`);
      }
    } catch (error) {
      this.logger.error('Не удалось закрыть зависшие подключения', error);
    }
  }

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

  /** Повторно закрывает подключения, которые не удалось закрыть в БД при разрыве соединения. */
  async closeStale(now: Date = new Date()): Promise<void> {
    const sessionIds = this.presence.staleSessionIds();

    if (sessionIds.length === 0) {
      return;
    }

    await this.closeWhere({ id: { in: sessionIds } }, now);

    const stillOpen = await this.prisma.conferenceParticipantSession.findMany({
      where: { id: { in: sessionIds }, leftAt: null },
      select: { id: true },
    });
    const open = new Set(stillOpen.map((session) => session.id));

    this.presence.unmarkStale(sessionIds.filter((id) => !open.has(id)));
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
        closed += await this.presence.withRoomLock(roomId, async () => {
          const result = await this.prisma.$transaction(async (tx) => {
            await lockRoom(tx, roomId);

            return closeSessions(tx, conferenceId, ids, now);
          });

          await this.events.sessionsClosed(conferenceId, ids, {
            emptied: result.emptied ? result.conference : null,
          });

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
