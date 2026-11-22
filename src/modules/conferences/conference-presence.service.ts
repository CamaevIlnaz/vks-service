import { Injectable } from '@nestjs/common';

/** Активное подключение сокета. sessionId — запись conference_participant_sessions. */
export interface PresenceConnection {
  conferenceId: string;
  participantId: string;
  sessionId: string;
  roomId: string;
}

/**
 * Онлайн-присутствие в памяти одного экземпляра NestJS.
 *
 * Блокировка комнаты (`withRoomLock`) сериализует изменения присутствия и рассылку событий
 * вместе с транзакцией: состояние в памяти меняется в том же порядке, что и в БД под `lockRoom`.
 * Блокировка сокета (`withSocketLock`) сериализует join/leave/disconnect одного сокета.
 * Порядок захвата: сокет, затем комната — обратного вложения нет.
 */
@Injectable()
export class ConferencePresenceService {
  private readonly connections = new Map<string, PresenceConnection>();
  /** conferenceId → participantId → socketId[] */
  private readonly conferences = new Map<string, Map<string, Set<string>>>();
  private readonly socketsBySession = new Map<string, string>();
  /** Подключения, которые не удалось закрыть в БД после разрыва соединения. */
  private readonly staleSessions = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  get(socketId: string): PresenceConnection | undefined {
    return this.connections.get(socketId);
  }

  add(socketId: string, connection: PresenceConnection): void {
    this.remove(socketId);
    this.connections.set(socketId, connection);
    this.socketsBySession.set(connection.sessionId, socketId);

    const participants =
      this.conferences.get(connection.conferenceId) ?? new Map();
    const sockets = participants.get(connection.participantId) ?? new Set();

    sockets.add(socketId);
    participants.set(connection.participantId, sockets);
    this.conferences.set(connection.conferenceId, participants);
  }

  remove(socketId: string): PresenceConnection | undefined {
    const connection = this.connections.get(socketId);

    if (!connection) {
      return undefined;
    }

    this.connections.delete(socketId);
    this.socketsBySession.delete(connection.sessionId);

    const participants = this.conferences.get(connection.conferenceId);
    const sockets = participants?.get(connection.participantId);

    sockets?.delete(socketId);
    if (sockets?.size === 0) {
      participants!.delete(connection.participantId);
    }
    if (participants?.size === 0) {
      this.conferences.delete(connection.conferenceId);
    }

    return connection;
  }

  /** Удаляет все подключения конференции и возвращает их socketId. */
  removeConference(conferenceId: string): string[] {
    const socketIds = [
      ...(this.conferences.get(conferenceId)?.values() ?? []),
    ].flatMap((sockets) => [...sockets]);

    for (const socketId of socketIds) {
      this.remove(socketId);
    }

    return socketIds;
  }

  socketIdsBySessions(sessionIds: string[]): string[] {
    return sessionIds
      .map((sessionId) => this.socketsBySession.get(sessionId))
      .filter((socketId): socketId is string => socketId !== undefined);
  }

  socketIdsOfParticipant(
    conferenceId: string,
    participantId: string,
  ): string[] {
    return [...(this.conferences.get(conferenceId)?.get(participantId) ?? [])];
  }

  connectionsCount(conferenceId: string, participantId: string): number {
    return this.conferences.get(conferenceId)?.get(participantId)?.size ?? 0;
  }

  /** participantId → число подключений. Несколько устройств участника — одна запись. */
  onlineParticipants(conferenceId: string): Map<string, number> {
    const participants = this.conferences.get(conferenceId);

    return new Map(
      [...(participants ?? [])].map(([participantId, sockets]) => [
        participantId,
        sockets.size,
      ]),
    );
  }

  participantsCount(conferenceId: string): number {
    return this.conferences.get(conferenceId)?.size ?? 0;
  }

  markStale(sessionId: string): void {
    this.staleSessions.add(sessionId);
  }

  staleSessionIds(): string[] {
    return [...this.staleSessions];
  }

  unmarkStale(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.staleSessions.delete(sessionId);
    }
  }

  withRoomLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    return this.runExclusive(`room:${roomId}`, task);
  }

  withSocketLock<T>(socketId: string, task: () => Promise<T>): Promise<T> {
    return this.runExclusive(`socket:${socketId}`, task);
  }

  private async runExclusive<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.then(task);
    const tail = current.catch(() => undefined);

    this.locks.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }
}
