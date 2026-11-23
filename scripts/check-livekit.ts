import 'dotenv/config';
import { RoomServiceClient } from 'livekit-server-sdk';
import { io } from 'socket.io-client';

const apiUrl = process.env.LIVEKIT_API_URL?.trim();
const apiKey = process.env.LIVEKIT_API_KEY?.trim();
const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
const prefix = (process.env.API_PREFIX ?? 'api').replace(/^\/+|\/+$/g, '');
const baseUrl = process.env.API_URL?.trim() || 'http://127.0.0.1:3000';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!apiUrl || !apiKey || !apiSecret) {
  fail('Не заданы LIVEKIT_API_URL, LIVEKIT_API_KEY или LIVEKIT_API_SECRET');
}

const client = new RoomServiceClient(apiUrl, apiKey, apiSecret, {
  requestTimeout: 3,
  failover: false,
});

try {
  const rooms = await client.listRooms();
  console.log(
    `LiveKit API доступен: ${apiUrl}, активных комнат: ${rooms.length}`,
  );
} catch (error) {
  fail(
    `LiveKit API недоступен: ${error instanceof Error ? error.message : 'неизвестная ошибка'}`,
  );
}

const [email, password, slug] = process.argv.slice(2);

if (!email && !password && !slug) {
  console.log(
    'Чтобы ещё проверить выдачу токена: yarn livekit:check -- email password slug-комнаты',
  );
  console.log(
    'Нужен уже запущенный бэкенд. Токен печатается только в этот вывод, не в лог сервера.',
  );
  process.exit(0);
}

if (!email || !password || !slug) {
  fail('Передайте email, пароль и slug комнаты');
}

const login = await fetch(`${baseUrl}/${prefix}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

if (!login.ok) {
  fail(`Вход не выполнен: HTTP ${login.status}`);
}

const { accessToken } = (await login.json()) as { accessToken?: string };

if (!accessToken) {
  fail('В ответе входа нет accessToken');
}

const socket = io(`${baseUrl}/conferences`, {
  auth: { token: accessToken },
  transports: ['websocket'],
  reconnection: false,
});

const joined = await new Promise<{ sessionId?: string; error?: unknown }>(
  (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Не дождались входа в конференцию')),
      5_000,
    );
    socket.on('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('connect', () => {
      void socket
        .timeout(5_000)
        .emitWithAck('conference:join', { slug })
        .then((ack: { sessionId?: string; error?: unknown }) => {
          clearTimeout(timer);
          resolve(ack);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error('Ошибка входа'));
        });
    });
  },
).catch((error: unknown) => {
  socket.disconnect();
  throw error;
});

if (!joined.sessionId || joined.error) {
  socket.disconnect();
  fail('Не удалось открыть подключение к конференции');
}

const tokenResponse = await fetch(`${baseUrl}/${prefix}/media/token`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ sessionId: joined.sessionId }),
});
socket.disconnect();
const tokenBody = (await tokenResponse.json()) as {
  url?: string;
  token?: string;
  conferenceId?: string;
  participantId?: string;
  sessionId?: string;
  message?: string;
};

if (!tokenResponse.ok || !tokenBody.token) {
  fail(
    `Медиатокен не выдан: HTTP ${tokenResponse.status} ${tokenBody.message ?? ''}`.trim(),
  );
}

console.log(
  JSON.stringify(
    {
      url: tokenBody.url,
      conferenceId: tokenBody.conferenceId,
      participantId: tokenBody.participantId,
      sessionId: tokenBody.sessionId,
      token: tokenBody.token,
    },
    null,
    2,
  ),
);
