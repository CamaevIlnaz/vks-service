import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import { MediaService } from '../media/media.service.js';
import {
  Conference,
  ConferenceStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferencePresenceService } from './conference-presence.service.js';
import {
  ConferenceStateDto,
  ConferenceStateParticipantDto,
} from './dto/conference-state.dto.js';
import type { MessageDto } from './dto/message.dto.js';

export const CONFERENCE_EVENTS = {
  join: 'conference:join',
  leave: 'conference:leave',
  state: 'conference:state',
  updated: 'conference:updated',
  ended: 'conference:ended',
  participantJoined: 'participant:joined',
  participantLeft: 'participant:left',
  participantUpdated: 'participant:updated',
  messageCreated: 'message:created',
} as const;

const participantInclude = {
  user: { select: { name: true, avatarUrl: true } },
} satisfies Prisma.ConferenceParticipantInclude;

export function conferenceRoom(conferenceId: string): string {
  return `conference:${conferenceId}`;
}

/**
 * Рассылка WebSocket-событий участникам конференции.
 * Методы, меняющие присутствие, вызываются под `ConferencePresenceService.withRoomLock`.
 * Ошибка рассылки не отменяет уже сохранённое в БД изменение, поэтому только логируется.
 */
@Injectable()
export class ConferenceEventsService {
  private readonly logger = new Logger(ConferenceEventsService.name);
  private server: Namespace | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: ConferencePresenceService,
    @Inject(forwardRef(() => MediaService))
    private readonly media: MediaService,
  ) {}

  bindServer(server: Namespace): void {
    this.server = server;
  }

  /** Состояние строится по присутствию в памяти: в списке только участники онлайн. */
  async buildState(conferenceId: string): Promise<ConferenceStateDto> {
    const online = this.presence.onlineParticipants(conferenceId);
    const [conference, participants] = await this.prisma.$transaction([
      this.prisma.conference.findUniqueOrThrow({ where: { id: conferenceId } }),
      this.prisma.conferenceParticipant.findMany({
        where: { conferenceId, id: { in: [...online.keys()] } },
        include: participantInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    return ConferenceStateDto.fromEntity(
      conference,
      participants.map((participant) =>
        ConferenceStateParticipantDto.fromEntity(
          participant,
          online.get(participant.id) ?? 0,
        ),
      ),
    );
  }

  /** Остальным подключениям конференции, кроме самого сокета. */
  async participantConnected(
    socket: Socket,
    conferenceId: string,
    participantId: string,
  ): Promise<void> {
    await this.safely('participant connected', async () => {
      const participant = await this.loadParticipant(
        conferenceId,
        participantId,
      );

      if (!participant) {
        return;
      }

      socket
        .to(conferenceRoom(conferenceId))
        .emit(
          participant.connectionsCount === 1
            ? CONFERENCE_EVENTS.participantJoined
            : CONFERENCE_EVENTS.participantUpdated,
          {
            conferenceId,
            participant,
            participantsCount: this.presence.participantsCount(conferenceId),
          },
        );
    });
  }

  /**
   * Подключения закрыты в БД. Сокеты этих подключений убираются из присутствия;
   * чужие (закрытые не самим сокетом: отзыв авторизации, выход через REST) отключаются.
   */
  async sessionsClosed(
    conferenceId: string,
    sessionIds: string[],
    options: { emptied?: Conference | null; initiatorSocketId?: string } = {},
  ): Promise<void> {
    const room = conferenceRoom(conferenceId);
    const affected = new Set<string>();

    for (const socketId of this.presence.socketIdsBySessions(sessionIds)) {
      const connection = this.presence.remove(socketId);

      if (!connection) {
        continue;
      }

      affected.add(connection.participantId);

      const socket = this.server?.sockets.get(socketId);

      void socket?.leave(room);
      if (socketId !== options.initiatorSocketId) {
        socket?.disconnect(true);
      }
    }

    for (const participantId of affected) {
      await this.participantDisconnected(conferenceId, participantId);
    }

    if (options.emptied) {
      this.conferenceUpdated(options.emptied);
    }

    await this.media.onSessionsClosed(conferenceId, sessionIds);
  }

  conferenceUpdated(conference: Conference): void {
    this.server
      ?.to(conferenceRoom(conference.id))
      .emit(CONFERENCE_EVENTS.updated, {
        conferenceId: conference.id,
        roomId: conference.roomId,
        status: conference.status,
        emptyAt: conference.emptyAt,
      });
  }

  async conferenceEnded(conferenceId: string, endedAt: Date): Promise<void> {
    const room = conferenceRoom(conferenceId);

    await this.media.onConferenceEnded(conferenceId);
    this.presence.removeConference(conferenceId);
    this.server?.to(room).emit(CONFERENCE_EVENTS.ended, {
      conferenceId,
      status: ConferenceStatus.ENDED,
      endedAt,
    });
    this.server?.in(room).socketsLeave(room);
  }

  /** isMine у каждого получателя свой, поэтому автору сообщение уходит отдельно. */
  messageCreated(conferenceId: string, message: MessageDto): void {
    if (!this.server) {
      return;
    }

    const authorSockets = this.presence.socketIdsOfParticipant(
      conferenceId,
      message.author.participantId,
    );

    this.server
      .to(conferenceRoom(conferenceId))
      .except(authorSockets)
      .emit(CONFERENCE_EVENTS.messageCreated, {
        ...message,
        conferenceId,
        isMine: false,
      });

    if (authorSockets.length > 0) {
      this.server.to(authorSockets).emit(CONFERENCE_EVENTS.messageCreated, {
        ...message,
        conferenceId,
        isMine: true,
      });
    }
  }

  private async participantDisconnected(
    conferenceId: string,
    participantId: string,
  ): Promise<void> {
    await this.safely('participant disconnected', async () => {
      const room = conferenceRoom(conferenceId);
      const participantsCount = this.presence.participantsCount(conferenceId);

      if (this.presence.connectionsCount(conferenceId, participantId) === 0) {
        this.server?.to(room).emit(CONFERENCE_EVENTS.participantLeft, {
          conferenceId,
          participantId,
          participantsCount,
        });
        return;
      }

      const participant = await this.loadParticipant(
        conferenceId,
        participantId,
      );

      if (participant) {
        this.server?.to(room).emit(CONFERENCE_EVENTS.participantUpdated, {
          conferenceId,
          participant,
          participantsCount,
        });
      }
    });
  }

  private async loadParticipant(
    conferenceId: string,
    participantId: string,
  ): Promise<ConferenceStateParticipantDto | null> {
    const participant = await this.prisma.conferenceParticipant.findFirst({
      where: { id: participantId, conferenceId },
      include: participantInclude,
    });

    return participant
      ? ConferenceStateParticipantDto.fromEntity(
          participant,
          this.presence.connectionsCount(conferenceId, participantId),
        )
      : null;
  }

  private async safely(
    action: string,
    task: () => Promise<void>,
  ): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.error(`Не удалось разослать событие: ${action}`, error);
    }
  }
}
