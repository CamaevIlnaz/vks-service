import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions } from 'socket.io';

const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Браузер не применяет CORS к WebSocket, поэтому Origin проверяется в `allowRequest`
 * для всех транспортов, а `cors` нужен только для long polling.
 * Запрос без Origin пришёл не из браузера и cookie не несёт — авторизация идёт по токену из handshake.
 */
export function isOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: string[],
): boolean {
  const { origin, host } = request.headers;

  if (!origin) {
    return true;
  }

  if (allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export class SocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  createIOServer(port: number | undefined, options?: ServerOptions): Server {
    const serverOptions: Partial<ServerOptions> = {
      ...options,
      maxHttpBufferSize: MAX_MESSAGE_BYTES,
      cors: {
        origin: this.allowedOrigins.length > 0 ? this.allowedOrigins : false,
        credentials: true,
      },
      allowRequest: (request, callback) =>
        callback(null, isOriginAllowed(request, this.allowedOrigins)),
    };

    return super.createIOServer(port, serverOptions as ServerOptions);
  }
}
