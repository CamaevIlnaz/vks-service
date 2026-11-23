import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../auth/auth.types.js';

/** Кто выполняет запрос: пользователь по access token или гость по подписанному гостевому токену. */
export type ConferenceActor =
  { kind: 'user'; userId: number } | { kind: 'guest'; guestId: string };

export type ConferenceActorRequest = FastifyRequest & {
  user?: AuthUser;
  actor: ConferenceActor;
};

export function isActorParticipant(
  actor: ConferenceActor,
  participant: { userId: number | null; guestId: string | null },
): boolean {
  return actor.kind === 'user'
    ? participant.userId === actor.userId
    : participant.guestId === actor.guestId;
}
