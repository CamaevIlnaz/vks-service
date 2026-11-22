import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type {
  ConferenceActor,
  ConferenceActorRequest,
} from '../conference.types.js';

/** Требует `ConferenceActorGuard` на маршруте. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ConferenceActor =>
    context.switchToHttp().getRequest<ConferenceActorRequest>().actor,
);
