import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e.vks.test';
const PASSWORD = 'correct-horse-battery';

let app: NestFastifyApplication;
let prisma: PrismaService;
let prefix: string;
let ipCounter = 0;

// Каждый «клиент» получает свой IP, чтобы rate limiting не мешал соседним тестам.
function nextIp(): string {
  ipCounter += 1;
  return `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function uniqueEmail(): string {
  return `user-${randomUUID()}@${EMAIL_DOMAIN}`;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  userId: number;
}

function cookieValue(
  response: Awaited<ReturnType<NestFastifyApplication['inject']>>,
  name: string,
): string | undefined {
  return response.cookies.find((cookie) => cookie.name === name)?.value;
}

function toSession(
  response: Awaited<ReturnType<NestFastifyApplication['inject']>>,
): Session {
  const body = response.json();

  return {
    accessToken: body.accessToken,
    csrfToken: body.csrfToken,
    refreshToken: cookieValue(response, 'refresh_token')!,
    userId: body.user.id,
  };
}

function register(email = uniqueEmail(), ip = nextIp()) {
  return app.inject({
    method: 'POST',
    url: `/${prefix}/auth/register`,
    remoteAddress: ip,
    payload: { email, password: PASSWORD, name: 'Тест' },
  });
}

function login(email: string, password = PASSWORD, ip = nextIp()) {
  return app.inject({
    method: 'POST',
    url: `/${prefix}/auth/login`,
    remoteAddress: ip,
    payload: { email, password },
  });
}

function refresh(session: Pick<Session, 'refreshToken' | 'csrfToken'>) {
  return app.inject({
    method: 'POST',
    url: `/${prefix}/auth/refresh`,
    remoteAddress: nextIp(),
    cookies: { refresh_token: session.refreshToken },
    headers: { 'x-csrf-token': session.csrfToken },
  });
}

function getMe(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: `/${prefix}/users/me`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { rawBody: true },
  );
  await setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  prefix = process.env.API_PREFIX!.replace(/^\/+|\/+$/g, '');
});

afterAll(async () => {
  await prisma?.user.deleteMany({
    where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
  });
  await app?.close();
});

describe('регистрация', () => {
  it('создаёт пользователя, нормализует email и выставляет cookie', async () => {
    const email = uniqueEmail();
    const response = await register(`  ${email.toUpperCase()} `);

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.role).toBe('USER');
    expect(body.user.emailVerifiedAt).toEqual(expect.any(String));
    expect(body.user).not.toHaveProperty('passwordHash');
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);

    const refreshCookie = response.cookies.find(
      (cookie) => cookie.name === 'refresh_token',
    );
    expect(refreshCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: `/${prefix}/auth`,
    });
    expect(cookieValue(response, 'csrf_token')).toBe(body.csrfToken);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('отклоняет занятый email', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await register(email.toUpperCase());

    expect(response.statusCode).toBe(409);
  });

  it('валидирует DTO', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/${prefix}/auth/register`,
      remoteAddress: nextIp(),
      payload: {
        email: 'not-an-email',
        password: 'short',
        name: '',
        role: 'ADMIN',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('ограничивает частоту запросов', async () => {
    const ip = nextIp();
    const statuses: number[] = [];

    for (let i = 0; i < 6; i += 1) {
      statuses.push((await register(uniqueEmail(), ip)).statusCode);
    }

    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
  });
});

describe('вход', () => {
  it('выдаёт токены по верному паролю', async () => {
    const email = uniqueEmail();
    await register(email);

    const response = await login(email.toUpperCase());

    expect(response.statusCode).toBe(200);
    const session = toSession(response);
    expect(session.refreshToken).toBeDefined();

    const me = await getMe(session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(email);
  });

  it('отклоняет неверный пароль и неизвестный email одинаково', async () => {
    const email = uniqueEmail();
    await register(email);

    const wrongPassword = await login(email, 'wrong-password');
    const unknownEmail = await login(uniqueEmail());

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json().message).toBe(unknownEmail.json().message);
  });

  it('не пускает заблокированного пользователя', async () => {
    const email = uniqueEmail();
    const session = toSession(await register(email));
    await prisma.user.update({
      where: { email },
      data: { status: 'BLOCKED' },
    });

    expect((await login(email)).statusCode).toBe(403);
    expect((await getMe(session.accessToken)).statusCode).toBe(403);
    expect((await refresh(session)).statusCode).toBe(403);
  });

  it('требует access token для профиля', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/${prefix}/users/me`,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('обновление токенов', () => {
  it('ротирует refresh token', async () => {
    const session = toSession(await register());

    const response = await refresh(session);

    expect(response.statusCode).toBe(200);
    const next = toSession(response);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.csrfToken).not.toBe(session.csrfToken);
    expect((await getMe(next.accessToken)).statusCode).toBe(200);
  });

  it('требует CSRF-токен', async () => {
    const session = toSession(await register());

    const withoutHeader = await app.inject({
      method: 'POST',
      url: `/${prefix}/auth/refresh`,
      remoteAddress: nextIp(),
      cookies: { refresh_token: session.refreshToken },
    });
    const wrongHeader = await refresh({
      refreshToken: session.refreshToken,
      csrfToken: 'forged',
    });

    expect(withoutHeader.statusCode).toBe(403);
    expect(wrongHeader.statusCode).toBe(403);
  });

  it('при повторном использовании отзывает сессию', async () => {
    const session = toSession(await register());
    const next = toSession(await refresh(session));

    const reused = await refresh(session);

    expect(reused.statusCode).toBe(401);
    expect(cookieValue(reused, 'refresh_token')).toBe('');
    expect((await refresh(next)).statusCode).toBe(401);
    expect((await getMe(next.accessToken)).statusCode).toBe(401);
  });

  it('при параллельных запросах с одним токеном успешен только один', async () => {
    const session = toSession(await register());

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => refresh(session)),
    );
    const succeeded = responses.filter(
      (response) => response.statusCode === 200,
    );

    expect(succeeded).toHaveLength(1);
  });
});

describe('выход и сессии', () => {
  it('logout отзывает текущую сессию', async () => {
    const session = toSession(await register());

    const response = await app.inject({
      method: 'POST',
      url: `/${prefix}/auth/logout`,
      cookies: { refresh_token: session.refreshToken },
      headers: { 'x-csrf-token': session.csrfToken },
    });

    expect(response.statusCode).toBe(204);
    expect(cookieValue(response, 'refresh_token')).toBe('');
    expect((await refresh(session)).statusCode).toBe(401);
    expect((await getMe(session.accessToken)).statusCode).toBe(401);
  });

  it('logout-all отзывает все сессии пользователя', async () => {
    const email = uniqueEmail();
    const first = toSession(await register(email));
    const second = toSession(await login(email));

    const response = await app.inject({
      method: 'POST',
      url: `/${prefix}/auth/logout-all`,
      headers: { authorization: `Bearer ${first.accessToken}` },
    });

    expect(response.statusCode).toBe(204);
    expect((await getMe(first.accessToken)).statusCode).toBe(401);
    expect((await getMe(second.accessToken)).statusCode).toBe(401);
    expect((await refresh(second)).statusCode).toBe(401);
  });

  it('показывает и отзывает отдельные сессии', async () => {
    const email = uniqueEmail();
    const current = toSession(await register(email));
    const other = toSession(await login(email));
    const auth = { authorization: `Bearer ${current.accessToken}` };

    const list = await app.inject({
      method: 'GET',
      url: `/${prefix}/auth/sessions`,
      headers: auth,
    });

    expect(list.statusCode).toBe(200);
    const sessions = list.json<{ id: string; isCurrent: boolean }[]>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1);

    const otherId = sessions.find((session) => !session.isCurrent)!.id;
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/${prefix}/auth/sessions/${otherId}`,
      headers: auth,
    });

    expect(revoke.statusCode).toBe(204);
    expect((await getMe(other.accessToken)).statusCode).toBe(401);
    expect((await refresh(other)).statusCode).toBe(401);
    expect((await getMe(current.accessToken)).statusCode).toBe(200);
  });

  it('не даёт отозвать чужую сессию', async () => {
    const owner = toSession(await register());
    const stranger = toSession(await register());
    const [ownerSession] = await prisma.authSession.findMany({
      where: { userId: owner.userId },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/${prefix}/auth/sessions/${ownerSession.id}`,
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });

    expect(response.statusCode).toBe(404);
    expect((await getMe(owner.accessToken)).statusCode).toBe(200);
  });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function avatarForm(content: Buffer, filename: string, mime: string) {
  const boundary = '----vks-avatar';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

function storedAvatarPath(avatarUrl: string): string {
  return path.join(
    process.cwd(),
    'uploads',
    'avatars',
    path.basename(avatarUrl),
  );
}

describe('профиль', () => {
  it('меняет имя и загружает аватар файлом', async () => {
    const session = toSession(await register());
    const auth = { authorization: `Bearer ${session.accessToken}` };
    const created: string[] = [];

    try {
      const nameResponse = await app.inject({
        method: 'PATCH',
        url: `/${prefix}/users/me`,
        headers: auth,
        payload: { name: '  Икам  ' },
      });

      expect(nameResponse.statusCode).toBe(200);
      expect(nameResponse.json()).toMatchObject({
        id: session.userId,
        name: 'Икам',
        avatarUrl: null,
      });

      const png = avatarForm(PNG, 'avatar.png', 'image/png');
      const avatarResponse = await app.inject({
        method: 'PATCH',
        url: `/${prefix}/users/me/avatar`,
        headers: { ...auth, ...png.headers },
        payload: png.payload,
      });

      expect(avatarResponse.statusCode).toBe(200);
      const avatarUrl = avatarResponse.json().avatarUrl as string;
      created.push(avatarUrl);
      expect(avatarUrl).toMatch(/^\/uploads\/avatars\/\d+-.+\.png$/);
      expect(avatarResponse.json().name).toBe('Икам');

      const file = await app.inject({ method: 'GET', url: avatarUrl });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toContain('image/png');
      expect(file.rawPayload).toEqual(PNG);

      const gif = avatarForm(GIF, 'avatar.gif', 'image/gif');
      const replaced = await app.inject({
        method: 'PATCH',
        url: `/${prefix}/users/me/avatar`,
        headers: { ...auth, ...gif.headers },
        payload: gif.payload,
      });

      expect(replaced.statusCode).toBe(200);
      const nextUrl = replaced.json().avatarUrl as string;
      created.push(nextUrl);
      expect(nextUrl).toMatch(/\.gif$/);
      expect(
        (await app.inject({ method: 'GET', url: avatarUrl })).statusCode,
      ).toBe(404);
      expect((await getMe(session.accessToken)).json().avatarUrl).toBe(nextUrl);
    } finally {
      await Promise.all(
        created.map((avatarUrl) =>
          unlink(storedAvatarPath(avatarUrl)).catch(() => undefined),
        ),
      );
    }
  });

  it('отклоняет пустое имя, чужие поля и файл, который не является изображением', async () => {
    const session = toSession(await register());
    const auth = { authorization: `Bearer ${session.accessToken}` };

    const emptyBody = await app.inject({
      method: 'PATCH',
      url: `/${prefix}/users/me`,
      headers: auth,
      payload: {},
    });
    const emptyName = await app.inject({
      method: 'PATCH',
      url: `/${prefix}/users/me`,
      headers: auth,
      payload: { name: '   ' },
    });
    const extraField = await app.inject({
      method: 'PATCH',
      url: `/${prefix}/users/me`,
      headers: auth,
      payload: { name: 'Икам', role: 'ADMIN' },
    });
    const text = avatarForm(
      Buffer.from('not an image'),
      'note.txt',
      'text/plain',
    );
    const badAvatar = await app.inject({
      method: 'PATCH',
      url: `/${prefix}/users/me/avatar`,
      headers: { ...auth, ...text.headers },
      payload: text.payload,
    });

    expect(emptyBody.statusCode).toBe(400);
    expect(emptyName.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
    expect(badAvatar.statusCode).toBe(400);
  });
});
