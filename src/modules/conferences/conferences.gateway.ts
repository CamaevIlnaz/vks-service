import {
  ForbiddenException,
  HttpException,
  Logger,
  UnauthorizedException,
  UseFilters,
} from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from '@nestjs/websockets';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import { UserStatus } from '../../generated/prisma/client.js';
import { WsExceptionsFilter } from '../../common/ws-exceptions.filter.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { SessionsService } from '../auth/sessions.service.js';
import {
  CONFERENCE_EVENTS,
  conferenceRoom,
  ConferenceEventsService,
} from './conference-events.service.js';
import { ConferencePresenceService } from './conference-presence.service.js';
import {
  ConferencesService,
  detectDeviceType,
  type JoinIdentity,
  type JoinResult,
} from './conferences.service.js';
import { JoinConferenceDto } from './dto/join-conference.dto.js';
import type { JoinResponseDto } from './dto/join-response.dto.js';
import {
  GUEST_TOKEN_HEADER,
  GuestTokensService,
} from './guest-tokens.service.js';

export const CONFERENCES_NAMESPACE = '/conferences';

/** Личность определяется при handshake; гость без токена получает guestId при первом входе. */
type SocketIdentity =
  | { kind: 'user'; userId: number; authSessionId: string }
  | { kind: 'guest'; guestId: string | null };

interface ConferenceSocketData {
  identity: SocketIdentity;
  joined?: JoinResponseDto;
}

type ConferenceSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  ConferenceSocketData
>;

/**
 * Вход и выход из конференции по WebSocket (namespace `/conferences`).
 *
 * Handshake: `auth.token` — access token пользователя, либо `auth.guestToken` — гостевой токен.
 * Без токенов клиент подключается как новый гость. Гостевой токен из ответа на `conference:join`
 * нужно сохранить и передавать при переподключении, иначе сервер создаст нового гостя.
 * После каждого переподключения клиент повторно отправляет `conference:join`.
 */
@Public()
@UseFilters(new WsExceptionsFilter())
@WebSocketGateway({ namespace: CONFERENCES_NAMESPACE })
export class ConferencesGateway
  implements OnGatewayInit<Namespace>, OnGatewayDisconnect<ConferenceSocket>
{
  private readonly logger = new Logger(ConferencesGateway.name);

  constructor(
    private readonly conferencesService: ConferencesService,
    private readonly sessionsService: SessionsService,
    private readonly guestTokensService: GuestTokensService,
    private readonly presence: ConferencePresenceService,
    private readonly events: ConferenceEventsService,
  ) {}

  afterInit(server: Namespace): void {
    this.events.bindServer(server);
    server.use((socket, next) => {
      this.authenticate(socket).then(
        (identity) => {
          (socket as ConferenceSocket).data.identity = identity;
          next();
        },
        (error: unknown) => {
          if (!(error instanceof HttpException)) {
            this.logger.error('Ошибка авторизации WebSocket', error);
          }
          next(toConnectError(error));
        },
      );
    });
  }

  async handleDisconnect(socket: ConferenceSocket): Promise<void> {
    try {
      await this.presence.withSocketLock(socket.id, () =>
        this.leaveCurrent(socket, true),
      );
    } catch (error) {
      this.logger.error(`Ошибка при отключении сокета ${socket.id}`, error);
    }
  }

  @SubscribeMessage(CONFERENCE_EVENTS.join)
  join(
    @ConnectedSocket() socket: ConferenceSocket,
    @MessageBody() dto: JoinConferenceDto,
  ): Promise<JoinResponseDto> {
    return this.presence.withSocketLock(socket.id, () =>
      this.joinConference(socket, dto),
    );
  }

  @SubscribeMessage(CONFERENCE_EVENTS.leave)
  leave(
    @ConnectedSocket() socket: ConferenceSocket,
  ): Promise<{ left: boolean }> {
    return this.presence.withSocketLock(socket.id, async () => ({
      left: await this.leaveCurrent(socket, false),
    }));
  }

  /**
   * Повторный `conference:join` того же сокета в ту же комнату не создаёт новую сессию,
   * а только присылает актуальное состояние. Вход в другую комнату сначала закрывает текущую сессию.
   */
  private async joinConference(
    socket: ConferenceSocket,
    dto: JoinConferenceDto,
  ): Promise<JoinResponseDto> {
    if (socket.disconnected) {
      throw new WsException('Соединение закрыто');
    }

    const identity = await this.resolveIdentity(socket, dto);
    const roomId = await this.conferencesService.findRoomIdBySlug(dto.slug);
    const current = this.presence.get(socket.id);

    if (
      current?.roomId === roomId &&
      socket.data.joined?.sessionId === current.sessionId
    ) {
      try {
        await this.conferencesService.assertCanStay(
          roomId,
          identity.kind === 'user' ? identity.userId : null,
        );
      } catch (error) {
        try {
          await this.leaveCurrent(socket, false);
        } catch (leaveError) {
          this.logger.error(
            'Не удалось закрыть подключение без доступа к комнате',
            leaveError,
          );
        }

        throw error;
      }

      const state = await this.events.buildState(current.conferenceId);

      socket.emit(CONFERENCE_EVENTS.state, state);

      return { ...socket.data.joined, conferenceStatus: state.status };
    }

    await this.leaveCurrent(socket, false);

    return this.conferencesService.joinRoom(
      roomId,
      identity,
      dto.deviceType ??
        detectDeviceType(socket.handshake.headers['user-agent']),
      (result) => this.attach(socket, result, identity),
    );
  }

  /** Выполняется под блокировкой комнаты сразу после фиксации сессии в БД. */
  private async attach(
    socket: ConferenceSocket,
    result: JoinResult,
    identity: JoinIdentity,
  ): Promise<JoinResponseDto> {
    const conferenceId = result.conference.id;
    const participantId = result.participant.id;

    this.presence.add(socket.id, {
      conferenceId,
      participantId,
      sessionId: result.sessionId,
      roomId: result.room.id,
    });
    await socket.join(conferenceRoom(conferenceId));

    const response = await this.conferencesService.toJoinResponse(
      result,
      identity,
    );

    socket.data.joined = response;
    socket.emit(
      CONFERENCE_EVENTS.state,
      await this.events.buildState(conferenceId),
    );
    await this.events.participantConnected(socket, conferenceId, participantId);

    return response;
  }

  /**
   * Закрывает сессию сокета. При разрыве соединения сокет убирается из присутствия
   * даже если БД недоступна; незакрытая сессия повторно закроется планировщиком.
   */
  private async leaveCurrent(
    socket: ConferenceSocket,
    disconnected: boolean,
  ): Promise<boolean> {
    const current = this.presence.get(socket.id);

    socket.data.joined = undefined;

    if (!current) {
      return false;
    }

    try {
      await this.conferencesService.closeSession(
        current.roomId,
        current.conferenceId,
        current.sessionId,
        socket.id,
      );
    } catch (error) {
      if (!disconnected) {
        throw error;
      }

      this.logger.error(
        `Не удалось закрыть подключение ${current.sessionId}`,
        error,
      );
      this.presence.markStale(current.sessionId);
      await this.presence.withRoomLock(current.roomId, () =>
        this.events.sessionsClosed(current.conferenceId, [current.sessionId], {
          initiatorSocketId: socket.id,
        }),
      );
    }

    return true;
  }

  /** При каждом входе сессия авторизации проверяется заново: её могли отозвать после handshake. */
  private async resolveIdentity(
    socket: ConferenceSocket,
    dto: JoinConferenceDto,
  ): Promise<JoinIdentity> {
    const { identity } = socket.data;

    if (identity.kind === 'user') {
      const session = await this.sessionsService.findActive(
        identity.authSessionId,
        identity.userId,
      );

      if (!session) {
        throw new UnauthorizedException('Сессия завершена');
      }

      if (session.user.status !== UserStatus.ACTIVE) {
        throw new ForbiddenException('Учётная запись заблокирована');
      }

      return this.conferencesService.resolveJoinIdentity(
        { id: identity.userId, sessionId: identity.authSessionId },
        null,
        undefined,
      );
    }

    const joinIdentity = this.conferencesService.resolveJoinIdentity(
      null,
      identity.guestId,
      dto.guestName,
    );

    if (joinIdentity.kind === 'guest') {
      identity.guestId = joinIdentity.guestId;
    }

    return joinIdentity;
  }

  /**
   * Недействительный access token отклоняет подключение: клиент должен обновить токен.
   * Недействительный гостевой токен игнорируется, как и в REST: гость получит новый guestId.
   */
  private async authenticate(socket: Socket): Promise<SocketIdentity> {
    const auth = socket.handshake.auth as Record<string, unknown>;
    const headers = socket.handshake.headers;
    const token =
      stringOrNull(auth.token) ?? stringOrNull(headers.authorization);

    if (token) {
      const user = await this.sessionsService.authenticate(
        token.replace(/^Bearer\s+/i, ''),
      );

      return { kind: 'user', userId: user.id, authSessionId: user.sessionId };
    }

    const guestToken =
      stringOrNull(auth.guestToken) ??
      stringOrNull(headers[GUEST_TOKEN_HEADER]);

    return {
      kind: 'guest',
      guestId: guestToken
        ? await this.guestTokensService.verify(guestToken)
        : null,
    };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Ошибка middleware приходит клиенту в `connect_error`: `err.message` и `err.data.statusCode`. */
function toConnectError(error: unknown): Error {
  const isHttp = error instanceof HttpException;
  const connectError = new Error(
    isHttp ? error.message : 'Internal server error',
  ) as Error & { data?: { statusCode: number } };

  connectError.data = { statusCode: isHttp ? error.getStatus() : 500 };

  return connectError;
}
