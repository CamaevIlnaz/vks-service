import {
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { ConferenceStatus } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import type { ConferenceActor } from '../../conferences/conference.types.js';
import { RoomAccessService } from '../../rooms/room-access.service.js';
import { DocumentAccessDto } from '../dto/document-access.dto.js';
import { documentName, parseDocumentName } from './document-name.js';

export const DOCUMENT_TOKEN_AUDIENCE = 'vks-document';

/** Контекст соединения Hocuspocus. Роль клиента сюда не входит. */
export interface CollaborationContext {
  documentId: string;
  conferenceId: string;
  participantId: string;
  actor: ConferenceActor;
}

export function isCollaborationContext(
  value: unknown,
): value is CollaborationContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CollaborationContext>;

  if (
    !isUUID(candidate.documentId) ||
    !isUUID(candidate.conferenceId) ||
    !isUUID(candidate.participantId) ||
    !candidate.actor
  ) {
    return false;
  }

  if (candidate.actor.kind === 'user') {
    return (
      Number.isInteger(candidate.actor.userId) && candidate.actor.userId > 0
    );
  }

  return candidate.actor.kind === 'guest' && isUUID(candidate.actor.guestId);
}

interface DocumentTokenPayload {
  sub: string;
  conferenceId: string;
  participantId: string;
  userId?: number;
  guestId?: string;
}

interface EditAccess {
  roomId: string;
  documentId: string;
  conferenceId: string;
  participantId: string;
  actor: ConferenceActor;
}

/** Hocuspocus читает `error.reason` и отдаёт его клиенту как permission-denied. */
export class CollaborationDenied extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

function httpMessage(error: unknown): string {
  if (error instanceof CollaborationDenied) {
    return error.reason;
  }

  if (error instanceof HttpException) {
    const response = error.getResponse();

    if (typeof response === 'string') {
      return response;
    }

    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message: unknown }).message;

      if (typeof message === 'string') {
        return message;
      }

      if (Array.isArray(message) && typeof message[0] === 'string') {
        return message[0];
      }
    }
  }

  return 'Доступ запрещён';
}

/**
 * Токен только называет документ, конференцию и участника.
 * Право редактировать каждый раз читается из базы, а не из утверждений клиента.
 */
@Injectable()
export class CollaborationAuthService {
  private readonly url: string;
  private readonly ttlSeconds: number;
  private gate: { isSealed(conferenceId: string): boolean } = {
    isSealed: () => false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly roomAccess: RoomAccessService,
    configService: ConfigService,
  ) {
    this.url = configService.getOrThrow<string>('collaboration.url');
    this.ttlSeconds = configService.getOrThrow<number>(
      'collaboration.tokenTtlSeconds',
    );
  }

  /** Конференция, которую уже начали завершать, больше не выдаёт доступ. */
  bindGate(gate: { isSealed(conferenceId: string): boolean }): void {
    this.gate = gate;
  }

  issueToken(
    roomId: string,
    documentId: string,
    actor: ConferenceActor,
  ): Promise<DocumentAccessDto> {
    return this.requireEditAccess({ roomId, documentId, actor }).then(
      async (access) => ({
        token: await this.sign(access),
        documentName: documentName(access.documentId),
        url: this.url,
        expiresIn: this.ttlSeconds,
      }),
    );
  }

  async authenticateSocket(
    token: string,
    name: string,
  ): Promise<CollaborationContext> {
    try {
      const payload = await this.verify(token);

      if (!payload) {
        throw new UnauthorizedException('Недействительный токен документа');
      }

      const documentId = parseDocumentName(name);

      if (!documentId || documentId !== payload.sub) {
        throw new ForbiddenException('Токен выдан для другого документа');
      }

      const actor: ConferenceActor =
        payload.userId !== undefined
          ? { kind: 'user', userId: payload.userId }
          : { kind: 'guest', guestId: payload.guestId! };
      const access = await this.requireEditAccess({
        roomId: null,
        documentId,
        actor,
        conferenceId: payload.conferenceId,
        participantId: payload.participantId,
      });

      return {
        documentId: access.documentId,
        conferenceId: access.conferenceId,
        participantId: access.participantId,
        actor: access.actor,
      };
    } catch (error) {
      throw new CollaborationDenied(httpMessage(error));
    }
  }

  private sign(access: EditAccess): Promise<string> {
    const payload: DocumentTokenPayload = {
      sub: access.documentId,
      conferenceId: access.conferenceId,
      participantId: access.participantId,
      ...(access.actor.kind === 'user'
        ? { userId: access.actor.userId }
        : { guestId: access.actor.guestId }),
    };

    return this.jwtService.signAsync(payload);
  }

  private async verify(token: string): Promise<DocumentTokenPayload | null> {
    try {
      const payload =
        await this.jwtService.verifyAsync<DocumentTokenPayload>(token);
      const hasUser =
        typeof payload.userId === 'number' &&
        Number.isInteger(payload.userId) &&
        payload.userId > 0;
      const hasGuest =
        typeof payload.guestId === 'string' && isUUID(payload.guestId);

      if (
        !isUUID(payload.sub) ||
        !isUUID(payload.conferenceId) ||
        !isUUID(payload.participantId) ||
        hasUser === hasGuest
      ) {
        return null;
      }

      return {
        sub: payload.sub,
        conferenceId: payload.conferenceId,
        participantId: payload.participantId,
        ...(hasUser
          ? { userId: payload.userId }
          : { guestId: payload.guestId }),
      };
    } catch {
      return null;
    }
  }

  private async requireEditAccess(input: {
    roomId: string | null;
    documentId: string;
    actor: ConferenceActor;
    conferenceId?: string;
    participantId?: string;
  }): Promise<EditAccess> {
    const document = await this.prisma.roomDocument.findFirst({
      where: {
        id: input.documentId,
        deletedAt: null,
        ...(input.roomId ? { roomId: input.roomId } : {}),
      },
      select: {
        id: true,
        roomId: true,
        room: {
          select: {
            id: true,
            ownerId: true,
            accessType: true,
            deletedAt: true,
            status: true,
            type: true,
            expiresAt: true,
          },
        },
      },
    });

    if (!document || document.room.deletedAt) {
      throw new NotFoundException('Документ не найден');
    }

    const conference = await this.prisma.conference.findFirst({
      where: {
        roomId: document.roomId,
        status: ConferenceStatus.ACTIVE,
      },
      select: { id: true },
    });

    if (!conference) {
      return this.denyWithoutActiveConference(
        document.roomId,
        document.room.ownerId,
        input.actor,
      );
    }

    if (input.conferenceId && input.conferenceId !== conference.id) {
      throw new ForbiddenException('Токен выдан для другой конференции');
    }

    if (this.gate.isSealed(conference.id)) {
      throw new ForbiddenException('Конференция завершается');
    }

    const participant = await this.prisma.conferenceParticipant.findFirst({
      where:
        input.actor.kind === 'user'
          ? { conferenceId: conference.id, userId: input.actor.userId }
          : { conferenceId: conference.id, guestId: input.actor.guestId },
      select: { id: true },
    });

    if (!participant) {
      if (
        input.actor.kind === 'user' &&
        document.room.ownerId === input.actor.userId
      ) {
        throw new ForbiddenException(
          'Для редактирования нужно участвовать в конференции',
        );
      }

      throw new NotFoundException('Документ не найден');
    }

    if (input.participantId && input.participantId !== participant.id) {
      throw new ForbiddenException('Токен выдан другому участнику');
    }

    const openSessions = await this.prisma.conferenceParticipantSession.count({
      where: { participantId: participant.id, leftAt: null },
    });

    if (openSessions === 0) {
      throw new ForbiddenException('Нет активного подключения к конференции');
    }

    const joinError = await this.roomAccess.getJoinError(
      document.room,
      input.actor.kind === 'user' ? input.actor.userId : null,
      true,
    );

    if (joinError) {
      throw joinError;
    }

    const attached = await this.prisma.conferenceDocument.findUnique({
      where: {
        conferenceId_documentId: {
          conferenceId: conference.id,
          documentId: document.id,
        },
      },
      select: { id: true },
    });

    if (!attached) {
      throw new ForbiddenException('Документ не прикреплён к конференции');
    }

    return {
      roomId: document.roomId,
      documentId: document.id,
      conferenceId: conference.id,
      participantId: participant.id,
      actor: input.actor,
    };
  }

  private async denyWithoutActiveConference(
    roomId: string,
    ownerId: number,
    actor: ConferenceActor,
  ): Promise<never> {
    if (actor.kind === 'guest') {
      const participated = await this.prisma.conferenceParticipant.findFirst({
        where: { guestId: actor.guestId, conference: { roomId } },
        select: { id: true },
      });

      if (participated) {
        throw new ForbiddenException('Конференция завершена');
      }

      throw new NotFoundException('Документ не найден');
    }

    if (actor.userId === ownerId) {
      throw new ForbiddenException(
        'Для редактирования нужна активная конференция',
      );
    }

    const participated = await this.prisma.conferenceParticipant.findFirst({
      where: { userId: actor.userId, conference: { roomId } },
      select: { id: true },
    });

    if (participated) {
      throw new ForbiddenException(
        'Для редактирования нужна активная конференция',
      );
    }

    throw new NotFoundException('Документ не найден');
  }
}
