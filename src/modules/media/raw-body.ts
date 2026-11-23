import type { FastifyRequest } from 'fastify';

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

/** Сырое тело нужно для проверки подписи: повторная сериализация JSON её ломает. */
export function readRawBody(request: FastifyRequest): Buffer | undefined {
  const direct = (request as RequestWithRawBody).rawBody;

  if (Buffer.isBuffer(direct)) {
    return direct;
  }

  const fromNode = (request.raw as { rawBody?: Buffer }).rawBody;

  return Buffer.isBuffer(fromNode) ? fromNode : undefined;
}

export function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = raw?.replace(/^Bearer\s+/i, '').trim();

  return normalized || undefined;
}
