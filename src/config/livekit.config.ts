import { registerAs } from '@nestjs/config';

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Не задано значение ${name}`);
  }

  return value;
}

function requiredUrl(name: string, protocols: string[]): string {
  const value = required(name);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Некорректный URL в ${name}`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(
      `${name} должен использовать протокол ${protocols.join(' или ')}`,
    );
  }

  return url.toString().replace(/\/$/, '');
}

/**
 * Адреса разделены специально: клиенты подключаются по WebSocket (`url`),
 * сервер ходит в Twirp API (`apiUrl`). В production это могут быть разные хосты.
 * Секрет не попадает в ответы API и используется только для подписи токенов.
 */
export const livekitConfig = registerAs('livekit', () => ({
  url: requiredUrl('LIVEKIT_URL', ['ws:', 'wss:']),
  apiUrl: requiredUrl('LIVEKIT_API_URL', ['http:', 'https:']),
  apiKey: required('LIVEKIT_API_KEY'),
  apiSecret: required('LIVEKIT_API_SECRET'),
}));
