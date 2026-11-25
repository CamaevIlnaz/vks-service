import { registerAs } from '@nestjs/config';

const DEFAULT_PORT = 1234;
const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_DEBOUNCE_MS = 10_000;

export const DOCUMENT_TOKEN_TTL_SECONDS = 5 * 60;

function parsePort(raw: string | undefined): number {
  const value = raw?.trim() || String(DEFAULT_PORT);
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректное значение COLLABORATION_PORT: ${value}`);
  }

  return port;
}

function parseMilliseconds(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw?.trim()) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new Error(`Некорректное значение ${name}: ${raw}`);
  }

  return value;
}

/** Порт и адрес отдельного WebSocket-сервера Hocuspocus. Секреты документа используют JWT_ACCESS_SECRET и другой audience. */
export const collaborationConfig = registerAs('collaboration', () => {
  const port = parsePort(process.env.COLLABORATION_PORT);
  const debounceMs = parseMilliseconds(
    'COLLABORATION_DEBOUNCE_MS',
    process.env.COLLABORATION_DEBOUNCE_MS,
    DEFAULT_DEBOUNCE_MS,
  );
  const maxDebounceMs = parseMilliseconds(
    'COLLABORATION_MAX_DEBOUNCE_MS',
    process.env.COLLABORATION_MAX_DEBOUNCE_MS,
    DEFAULT_MAX_DEBOUNCE_MS,
  );

  if (maxDebounceMs < debounceMs) {
    throw new Error(
      'COLLABORATION_MAX_DEBOUNCE_MS не может быть меньше COLLABORATION_DEBOUNCE_MS',
    );
  }

  const url = process.env.COLLABORATION_URL?.trim() || `ws://127.0.0.1:${port}`;

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Некорректное значение COLLABORATION_URL: ${url}`);
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('COLLABORATION_URL должен начинаться с ws:// или wss://');
  }

  return {
    port,
    url,
    debounceMs,
    maxDebounceMs,
    tokenTtlSeconds: DOCUMENT_TOKEN_TTL_SECONDS,
  };
});
