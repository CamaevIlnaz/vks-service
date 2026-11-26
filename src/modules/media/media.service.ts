import {
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ParticipantInfo, WebhookEvent } from 'livekit-server-sdk';
import { ConferenceStatus, UserStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConferencePresenceService } from '../conferences/conference-presence.service.js';
import {
  isActorParticipant,
  type ConferenceActor,
} from '../conferences/conference.types.js';
import { participantDisplayName } from '../conferences/dto/participant.dto.js';
import { RoomAccessService } from '../rooms/room-access.service.js';
import { MediaRoomDto } from './dto/media-room.dto.js';
import { MediaTokenDto } from './dto/media-token.dto.js';
import {
  isLivekitNotFound,
  LivekitService,
  livekitErrorMessage,
  participantStateName,
} from './livekit.service.js';
import { MediaPresenceService } from './media-presence.service.js';

const sessionInclude = {
  participant: {
    include: {
      conference: { include: { room: true } },
      user: { select: { name: true, avatarUrl: true, status: true } },
    },
  },
  authSession: true,
} as const;

/**
 * Медиадоступ поверх уже созданных конференции и сессии.
 * Webhook синхронизирует только медиаприсутствие и не закрывает Socket.IO.
 * Недоступность LiveKit не должна отменять уже сохранённый выход или завершение.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ConferencePresenceService))
    private readonly presence: ConferencePresenceService,
    private readonly mediaPresence: MediaPresenceService,
    private readonly livekit: LivekitService,
    private readonly roomAccess: RoomAccessService,
  ) {}

  async createToken(
    actor: ConferenceActor,
    sessionId: string,
  ): Promise<MediaTokenDto> {
    const session = await this.prisma.conferenceParticipantSession.findUnique({
      where: { id: sessionId },
      include: sessionInclude,
    });

    if (!session || !isActorParticipant(actor, session.participant)) {
      throw new NotFoundException('Подключение не найдено');
    }

    const roomId = session.participant.conference.roomId;

    return this.presence.withRoomLock(roomId, async () => {
      const current = await this.prisma.conferenceParticipantSession.findUnique(
        {
          where: { id: sessionId },
          include: sessionInclude,
        },
      );

      if (!current || !isActorParticipant(actor, current.participant)) {
        throw new NotFoundException('Подключение не найдено');
      }

      const { participant } = current;
      const conference = participant.conference;

      if (conference.status === ConferenceStatus.ENDED) {
        throw new ForbiddenException(
          'Нельзя подключиться к завершённой конференции',
        );
      }

      if (conference.status !== ConferenceStatus.ACTIVE) {
        throw new ForbiddenException('Конференция не активна');
      }

      if (current.leftAt) {
        throw new ForbiddenException('Подключение уже закрыто');
      }

      if (!this.presence.isSessionConnected(sessionId)) {
        throw new ForbiddenException('Нет активного подключения к конференции');
      }

      if (participant.userId !== null) {
        if (participant.user?.status !== UserStatus.ACTIVE) {
          throw new ForbiddenException('Учётная запись заблокирована');
        }

        const authSession = current.authSession;

        if (
          !authSession ||
          authSession.revokedAt ||
          authSession.expiresAt <= new Date()
        ) {
          throw new ForbiddenException('Сессия авторизации недействительна');
        }
      }

      // Новый токен не выдаётся без допуска. Уже выданный JWT короче пяти минут
      // и при повторном входе отклоняется в webhook participant_joined.
      const joinError = await this.roomAccess.getJoinError(
        conference.room,
        participant.userId,
        true,
      );

      if (joinError) {
        throw joinError;
      }

      const token = await this.livekit.createParticipantToken({
        room: conference.id,
        identity: current.id,
        name: participantDisplayName(participant),
        metadata: JSON.stringify({
          participantId: participant.id,
          userId: participant.userId,
          guestId: participant.guestId,
          role: participant.role,
        }),
        microphoneMuted: this.mediaPresence.isMuted(current.id),
      });

      return {
        url: this.livekit.url,
        token,
        conferenceId: conference.id,
        participantId: participant.id,
        sessionId: current.id,
      };
    });
  }

  async describeConference(conferenceId: string): Promise<MediaRoomDto> {
    try {
      const room = await this.livekit.getRoom(conferenceId);
      const participants = room
        ? await this.livekit.listParticipants(conferenceId)
        : [];

      return {
        url: this.livekit.url,
        conferenceId,
        room: room
          ? {
              name: room.name,
              sid: room.sid,
              numParticipants: room.numParticipants,
            }
          : null,
        participants: participants.map((participant) => ({
          identity: participant.identity,
          name: participant.name,
          state: participantStateName(participant.state),
        })),
      };
    } catch (error) {
      this.logger.error(
        `Не удалось получить медиакомнату ${conferenceId}: ${livekitErrorMessage(error)}`,
      );
      throw new ServiceUnavailableException('LiveKit временно недоступен');
    }
  }

  async muteMicrophone(conferenceId: string, sessionId: string): Promise<void> {
    this.mediaPresence.mute(sessionId);

    try {
      await this.livekit.muteMicrophone(conferenceId, sessionId);
    } catch (error) {
      this.logger.error(
        `Не удалось отключить микрофон ${sessionId}: ${livekitErrorMessage(error)}`,
      );
      throw new ServiceUnavailableException('LiveKit временно недоступен');
    }
  }

  /** Закрытые логические сессии отключаются от медиа, остальные устройства не передаются. */
  async onSessionsClosed(
    conferenceId: string,
    sessionIds: string[],
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      this.mediaPresence.forgetSession(sessionId);
    }

    await this.removeIdentities(conferenceId, sessionIds);
  }

  /**
   * После отзыва доступа снимает оставшиеся медиасоединения участника,
   * в том числе если webhook об уходе был потерян.
   */
  async disconnectParticipant(
    conferenceId: string,
    participantId: string,
  ): Promise<void> {
    const sessions = await this.prisma.conferenceParticipantSession.findMany({
      where: { participantId, participant: { conferenceId } },
      select: { id: true },
    });
    const owned = new Set(sessions.map((session) => session.id));

    for (const sessionId of owned) {
      this.mediaPresence.forgetSession(sessionId);
    }

    let identities = [...owned];

    try {
      const live = await this.livekit.listParticipants(conferenceId);
      identities = live
        .map((participant) => participant.identity)
        .filter((identity) => owned.has(identity));
    } catch (error) {
      this.logger.error(
        `Не удалось получить медиаучастников ${conferenceId}: ${livekitErrorMessage(error)}`,
      );
    }

    await this.removeIdentities(conferenceId, identities);
  }

  /** Комната LiveKit удаляется после завершения конференции. История в БД не трогается. */
  async onConferenceEnded(conferenceId: string): Promise<void> {
    this.mediaPresence.clearConference(conferenceId);

    try {
      await this.livekit.deleteRoom(conferenceId);
    } catch (error) {
      this.logger.error(
        `Не удалось удалить медиакомнату ${conferenceId}: ${livekitErrorMessage(error)}`,
      );
    }
  }

  async handleWebhook(
    rawBody: Buffer | undefined,
    authorization: string | undefined,
  ): Promise<void> {
    if (!rawBody?.length || !authorization) {
      throw new UnauthorizedException('Недействительная подпись webhook');
    }

    const body = rawBody.toString('utf8');
    let event: WebhookEvent;

    try {
      event = await this.livekit.receiveWebhook(body, authorization);
    } catch (error) {
      this.logger.warn(
        `Отклонён webhook LiveKit: ${livekitErrorMessage(error)}`,
      );
      throw new UnauthorizedException('Недействительная подпись webhook');
    }

    if (event.id && this.mediaPresence.hasEvent(event.id)) {
      return;
    }

    switch (event.event) {
      case 'participant_joined':
        await this.onParticipantJoined(event);
        break;
      case 'participant_left':
      case 'participant_connection_aborted':
        this.onParticipantLeft(event);
        break;
      case 'room_finished':
        this.onRoomFinished(event);
        break;
      default:
        break;
    }

    if (event.id) {
      this.mediaPresence.rememberEvent(event.id);
    }
  }

  /**
   * Сверяет медиакомнаты с конференциями. Потерянный webhook не создаёт конференцию
   * и не переводит ENDED обратно в ACTIVE. Ошибка LiveKit только логируется.
   */
  async reconcile(): Promise<void> {
    let rooms;

    try {
      rooms = await this.livekit.listRooms();
    } catch (error) {
      this.logger.error(
        `LiveKit недоступен, сверка пропущена: ${livekitErrorMessage(error)}`,
      );
      return;
    }

    const seen = new Set<string>();

    for (const room of rooms) {
      if (!room.name) {
        continue;
      }

      seen.add(room.name);

      if (!isUUID(room.name)) {
        continue;
      }

      try {
        await this.reconcileRoom(room.name);
      } catch (error) {
        this.logger.error(
          `Не удалось сверить медиакомнату ${room.name}: ${livekitErrorMessage(error)}`,
        );
      }
    }

    for (const connection of this.mediaPresence.entries()) {
      if (!seen.has(connection.conferenceId)) {
        this.mediaPresence.markMediaLeft(connection.sessionId);
      }
    }
  }

  private async reconcileRoom(conferenceId: string): Promise<void> {
    const conference = await this.prisma.conference.findUnique({
      where: { id: conferenceId },
      select: { status: true },
    });

    if (!conference || conference.status === ConferenceStatus.ENDED) {
      if (conference?.status === ConferenceStatus.ENDED) {
        await this.onConferenceEnded(conferenceId);
      }

      return;
    }

    let participants: ParticipantInfo[];

    try {
      participants = await this.livekit.listParticipants(conferenceId);
    } catch (error) {
      if (isLivekitNotFound(error)) {
        this.mediaPresence.clearConference(conferenceId);
        return;
      }

      throw error;
    }

    if (conference.status !== ConferenceStatus.ACTIVE) {
      await this.removeIdentities(
        conferenceId,
        participants.map((participant) => participant.identity),
      );
      this.mediaPresence.clearConference(conferenceId);
      return;
    }

    const live = new Set<string>();

    for (const participant of participants) {
      live.add(participant.identity);
      await this.syncLiveParticipant(conferenceId, participant.identity);
    }

    for (const connection of this.mediaPresence.listByConference(
      conferenceId,
    )) {
      if (!live.has(connection.sessionId)) {
        this.mediaPresence.markMediaLeft(connection.sessionId);
      }
    }
  }

  private async syncLiveParticipant(
    conferenceId: string,
    identity: string,
  ): Promise<void> {
    const session = await this.findOwnSession(conferenceId, identity);

    if (!session) {
      await this.removeIdentities(conferenceId, [identity]);
      this.mediaPresence.markMediaLeft(identity);
      return;
    }

    this.mediaPresence.markJoined({
      conferenceId,
      participantId: session.participantId,
      sessionId: identity,
      joinedAt: this.mediaPresence.get(identity)?.joinedAt ?? new Date(),
    });
  }

  private async onParticipantJoined(event: WebhookEvent): Promise<void> {
    const identity = event.participant?.identity;
    const roomName = event.room?.name;

    if (!identity || !roomName || !isUUID(roomName)) {
      return;
    }

    const session = await this.findOwnSession(roomName, identity);

    if (!session) {
      this.logger.warn(
        `Медиаподключение ${identity} отклонено: конференция ${roomName} его не допускает`,
      );
      await this.removeIdentities(roomName, [identity]);
      return;
    }

    this.mediaPresence.markJoined({
      conferenceId: roomName,
      participantId: session.participantId,
      sessionId: identity,
      joinedAt: new Date(),
    });
  }

  private onParticipantLeft(event: WebhookEvent): void {
    const identity = event.participant?.identity;
    const roomName = event.room?.name;

    if (!identity) {
      return;
    }

    const current = this.mediaPresence.get(identity);

    if (current && roomName && current.conferenceId !== roomName) {
      return;
    }

    this.mediaPresence.markMediaLeft(identity);
  }

  private onRoomFinished(event: WebhookEvent): void {
    const roomName = event.room?.name;

    if (!roomName) {
      return;
    }

    this.mediaPresence.clearConference(roomName);
  }

  /**
   * Сессия нашего приложения, которой ещё можно владеть медиасоединением.
   * Чужая конференция, закрытая сессия и ENDED сюда не попадают.
   */
  private async findOwnSession(
    conferenceId: string,
    identity: string,
  ): Promise<{ participantId: string } | null> {
    if (!isUUID(identity) || !isUUID(conferenceId)) {
      return null;
    }

    const session = await this.prisma.conferenceParticipantSession.findUnique({
      where: { id: identity },
      select: {
        leftAt: true,
        participant: {
          select: {
            id: true,
            userId: true,
            conferenceId: true,
            conference: { select: { status: true, room: true } },
          },
        },
      },
    });

    if (
      !session ||
      session.leftAt ||
      session.participant.conferenceId !== conferenceId ||
      session.participant.conference.status !== ConferenceStatus.ACTIVE ||
      !this.presence.isSessionConnected(identity)
    ) {
      return null;
    }

    const joinError = await this.roomAccess.getJoinError(
      session.participant.conference.room,
      session.participant.userId,
      true,
    );

    if (joinError) {
      return null;
    }

    return { participantId: session.participant.id };
  }

  private async removeIdentities(
    conferenceId: string,
    identities: string[],
  ): Promise<void> {
    for (const identity of new Set(identities)) {
      try {
        await this.livekit.removeParticipant(conferenceId, identity);
      } catch (error) {
        this.logger.error(
          `Не удалось отключить медиа ${identity} в ${conferenceId}: ${livekitErrorMessage(error)}`,
        );
      }
    }
  }
}
