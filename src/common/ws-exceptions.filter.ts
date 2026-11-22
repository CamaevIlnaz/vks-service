import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';

export interface WsErrorPayload {
  status: 'error';
  statusCode: number;
  message: string | string[];
}

const UNKNOWN_ERROR: WsErrorPayload = {
  status: 'error',
  statusCode: 500,
  message: 'Internal server error',
};

/**
 * Исключения сервисов (HttpException) отдаются клиенту с тем же кодом и текстом, что и в REST.
 * Ошибка приходит событием `exception`, а если клиент ждёт ack — ещё и в ответ `{ error }`.
 */
@Catch()
export class WsExceptionsFilter extends BaseWsExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const wsException =
      exception instanceof HttpException
        ? new WsException(toPayload(exception))
        : exception;

    super.catch(wsException, host);

    const ack: unknown = host.getArgByIndex(2);

    if (typeof ack === 'function') {
      ack({ error: toAckError(wsException) });
    }
  }
}

function toPayload(exception: HttpException): WsErrorPayload {
  const response = exception.getResponse();
  const message =
    typeof response === 'object' && response !== null && 'message' in response
      ? (response.message as string | string[])
      : exception.message;

  return { status: 'error', statusCode: exception.getStatus(), message };
}

function toAckError(exception: unknown): WsErrorPayload {
  if (!(exception instanceof WsException)) {
    return UNKNOWN_ERROR;
  }

  const error = exception.getError();

  if (typeof error === 'string') {
    return { status: 'error', statusCode: 400, message: error };
  }

  return error instanceof Error ? UNKNOWN_ERROR : (error as WsErrorPayload);
}
