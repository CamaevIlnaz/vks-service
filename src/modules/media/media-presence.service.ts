import { Injectable } from '@nestjs/common';

/**
 * Фактическое медиасоединение LiveKit.
 * Это не WebSocket-присутствие: разрыв медиа не закрывает сокет и наоборот.
 */
export interface MediaConnection {
  conferenceId: string;
  participantId: string;
  sessionId: string;
  joinedAt: Date;
}

const MAX_EVENT_IDS = 1_000;

@Injectable()
export class MediaPresenceService {
  private readonly connections = new Map<string, MediaConnection>();
  /** sessionId, которым запрещён микрофон до закрытия логической сессии. */
  private readonly mutedSessions = new Set<string>();
  private readonly processedEvents = new Map<string, number>();

  markJoined(connection: MediaConnection): void {
    this.connections.set(connection.sessionId, connection);
  }

  /** Медиа оборвалось, логическая сессия конференции ещё может быть открыта. */
  markMediaLeft(sessionId: string): void {
    this.connections.delete(sessionId);
  }

  /** Сессия подключения закрыта: медиа и запрет микрофона больше не нужны. */
  forgetSession(sessionId: string): void {
    this.connections.delete(sessionId);
    this.mutedSessions.delete(sessionId);
  }

  clearConference(conferenceId: string): void {
    for (const [sessionId, connection] of this.connections) {
      if (connection.conferenceId === conferenceId) {
        this.connections.delete(sessionId);
      }
    }
  }

  get(sessionId: string): MediaConnection | undefined {
    return this.connections.get(sessionId);
  }

  isConnected(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  listByConference(conferenceId: string): MediaConnection[] {
    return [...this.connections.values()].filter(
      (connection) => connection.conferenceId === conferenceId,
    );
  }

  listByParticipant(
    conferenceId: string,
    participantId: string,
  ): MediaConnection[] {
    return this.listByConference(conferenceId).filter(
      (connection) => connection.participantId === participantId,
    );
  }

  entries(): MediaConnection[] {
    return [...this.connections.values()];
  }

  mute(sessionId: string): void {
    this.mutedSessions.add(sessionId);
  }

  isMuted(sessionId: string): boolean {
    return this.mutedSessions.has(sessionId);
  }

  /** true, если этот id webhook уже обработан. */
  hasEvent(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  rememberEvent(eventId: string): void {
    if (!eventId || this.processedEvents.has(eventId)) {
      return;
    }

    this.processedEvents.set(eventId, Date.now());

    if (this.processedEvents.size <= MAX_EVENT_IDS) {
      return;
    }

    const oldest = this.processedEvents.keys().next().value;

    if (oldest) {
      this.processedEvents.delete(oldest);
    }
  }
}
