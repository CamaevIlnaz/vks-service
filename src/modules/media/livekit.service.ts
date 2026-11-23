import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccessToken,
  ParticipantInfo,
  ParticipantInfo_State,
  Room,
  RoomServiceClient,
  ServerError,
  TrackSource,
  VideoGrant,
  WebhookEvent,
  WebhookReceiver,
} from 'livekit-server-sdk';
import {
  LIVEKIT_REQUEST_TIMEOUT_SECONDS,
  MEDIA_TOKEN_TTL_SECONDS,
} from './media.constants.js';

/** Камера и демонстрация экрана остаются доступны после серверного mute микрофона. */
const PUBLISH_SOURCES_WITHOUT_MICROPHONE = [
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

export interface ParticipantTokenInput {
  room: string;
  identity: string;
  name: string;
  metadata: string;
  microphoneMuted: boolean;
}

export function livekitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'неизвестная ошибка';
}

export function isLivekitNotFound(error: unknown): boolean {
  return (
    error instanceof ServerError &&
    (error.status === 404 || error.code === 'not_found')
  );
}

export function participantStateName(state: ParticipantInfo_State): string {
  return ParticipantInfo_State[state] ?? 'UNKNOWN';
}

/**
 * Тонкая обёртка над RoomServiceClient и WebhookReceiver.
 * Методы не пишут в БД и не логируют токены и секрет.
 * `removeParticipant` разрывает текущее медиасоединение, но не отзывает уже
 * выданный JWT до конца его срока: self-hosted LiveKit этого не гарантирует.
 */
@Injectable()
export class LivekitService {
  private readonly client: RoomServiceClient;
  private readonly receiver: WebhookReceiver;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  readonly url: string;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('livekit.apiKey');
    this.apiSecret = configService.getOrThrow<string>('livekit.apiSecret');
    const apiUrl = configService.getOrThrow<string>('livekit.apiUrl');

    this.url = configService.getOrThrow<string>('livekit.url');
    this.client = new RoomServiceClient(apiUrl, this.apiKey, this.apiSecret, {
      requestTimeout: LIVEKIT_REQUEST_TIMEOUT_SECONDS,
      failover: false,
    });
    this.receiver = new WebhookReceiver(this.apiKey, this.apiSecret);
  }

  async createParticipantToken(input: ParticipantTokenInput): Promise<string> {
    const grant: VideoGrant = {
      roomJoin: true,
      room: input.room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    };

    if (input.microphoneMuted) {
      grant.canPublishSources = PUBLISH_SOURCES_WITHOUT_MICROPHONE;
    }

    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      name: input.name,
      metadata: input.metadata,
      ttl: MEDIA_TOKEN_TTL_SECONDS,
    });

    token.addGrant(grant);

    return token.toJwt();
  }

  receiveWebhook(
    body: string,
    authorization: string | undefined,
  ): Promise<WebhookEvent> {
    return this.receiver.receive(body, authorization, false, '30s');
  }

  async listRooms(): Promise<Room[]> {
    return this.client.listRooms();
  }

  async getRoom(room: string): Promise<Room | null> {
    const rooms = await this.client.listRooms([room]);

    return rooms.find((item) => item.name === room) ?? null;
  }

  async listParticipants(room: string): Promise<ParticipantInfo[]> {
    try {
      return await this.client.listParticipants(room);
    } catch (error) {
      if (isLivekitNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  /**
   * Отключает одно медиасоединение. Отсутствие участника — уже выполненная операция.
   * Уже выданный токен может снова открыть соединение, пока не истечёт;
   * доступ повторно проверяют выдача токена и webhook `participant_joined`.
   */
  async removeParticipant(room: string, identity: string): Promise<void> {
    try {
      await this.client.removeParticipant(room, identity);
    } catch (error) {
      if (isLivekitNotFound(error)) {
        return;
      }

      throw error;
    }
  }

  async deleteRoom(room: string): Promise<void> {
    try {
      await this.client.deleteRoom(room);
    } catch (error) {
      if (isLivekitNotFound(error)) {
        return;
      }

      throw error;
    }
  }

  async updatePermissions(
    room: string,
    identity: string,
    permission: VideoGrant,
  ): Promise<void> {
    try {
      await this.client.updateParticipant(room, identity, {
        permission: {
          canPublish: permission.canPublish,
          canSubscribe: permission.canSubscribe,
          canPublishData: permission.canPublishData,
          canPublishSources: permission.canPublishSources,
        },
      });
    } catch (error) {
      if (isLivekitNotFound(error)) {
        return;
      }

      throw error;
    }
  }

  /** Глушит уже опубликованный микрофон и запрещает публиковать его снова. */
  async muteMicrophone(room: string, identity: string): Promise<void> {
    try {
      const participant = await this.client.getParticipant(room, identity);

      for (const track of participant.tracks) {
        if (track.source === TrackSource.MICROPHONE && track.sid) {
          await this.client.mutePublishedTrack(room, identity, track.sid, true);
        }
      }
    } catch (error) {
      if (!isLivekitNotFound(error)) {
        throw error;
      }
    }

    await this.updatePermissions(room, identity, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: PUBLISH_SOURCES_WITHOUT_MICROPHONE,
    });
  }
}
