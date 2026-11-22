import { registerAs } from '@nestjs/config';

function requiredPath(name: string): string {
  const value = process.env[name]?.trim().replace(/^\/+|\/+$/g, '');

  if (!value) {
    throw new Error(`Не задано значение ${name}`);
  }

  return value;
}

/** `CORS_ORIGINS` — список origin через запятую. Пустой список: разрешён только тот же origin. */
function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        throw new Error(`Некорректный origin в CORS_ORIGINS: ${item}`);
      }
    });
}

export const appConfig = registerAs('app', () => {
  const rawPort = process.env.PORT ?? '3000';
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректное значение PORT: ${rawPort}`);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('Не задано значение DATABASE_URL');
  }

  const apiPrefix = requiredPath('API_PREFIX');
  const swaggerPath = requiredPath('SWAGGER_PATH');

  if (apiPrefix === swaggerPath) {
    throw new Error('API_PREFIX и SWAGGER_PATH не должны совпадать');
  }

  const corsOrigins = parseOrigins(process.env.CORS_ORIGINS);

  return { port, apiPrefix, swaggerPath, corsOrigins };
});
