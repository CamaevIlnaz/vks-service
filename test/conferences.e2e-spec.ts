import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { ConferencesScheduler } from '../src/modules/conferences/conferences.scheduler.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-conf.vks.test';

let app: NestFastifyApplication;
let prisma: PrismaService;
let scheduler: ConferencesScheduler;
let prefix: string;
let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface TestUser {
  id: number;
  email: string;
  auth: { authorization: string };
}

const PASSWORD = 'correct-horse-battery';

async function createUser(name = 'Тест'): Promise<TestUser> {
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const response = await app.inject({
    method: 'POST',
    url: `/${prefix}/auth/register`,
    remoteAddress: nextIp(),
    payload: { email, password: PASSWORD, name },
  });
  const body = response.json();

  return {
    id: body.user.id,
    email,
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

async function loginAgain(user: TestUser): Promise<TestUser> {
  const response = await app.inject({
    method: 'POST',
    url: `/${prefix}/auth/login`,
    remoteAddress: nextIp(),
    payload: { email: user.email, password: PASSWORD },
  });

  return {
    ...user,
    auth: { authorization: `Bearer ${response.json().accessToken}` },
  };
}

async function sessionLeftAt(sessionId: string): Promise<Date | null> {
  const session = await prisma.conferenceParticipantSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  return session.leftAt;
}

function api(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return app.inject({
    method,
    url: `/${prefix}${url}`,
    remoteAddress: nextIp(),
    headers: options.headers,
    payload: options.payload,
  });
}

async function createRoom(
  owner: TestUser,
  payload: object = { name: 'Комната' },
  path = '/rooms',
) {
  const response = await api('POST', path, { headers: owner.auth, payload });
  expect(response.statusCode).toBe(201);
  return response.json();
}

function join(
  slug: string,
  options: { headers?: Record<string, string>; payload?: object } = {},
) {
  return api('POST', `/rooms/by-slug/${slug}/join`, {
    headers: options.headers,
    payload: options.payload ?? {},
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  scheduler = app.get(ConferencesScheduler);
  prefix = process.env.API_PREFIX!.replace(/^\/+|\/+$/g, '');
});

afterAll(async () => {
  if (prisma) {
    const roomFilter = {
      room: { owner: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
    };
    await prisma.conferenceMessage.deleteMany({
      where: { conference: roomFilter },
    });
    await prisma.conferenceParticipantSession.deleteMany({
      where: { participant: { conference: roomFilter } },
    });
    await prisma.conferenceParticipant.deleteMany({
      where: { conference: roomFilter },
    });
    await prisma.conference.deleteMany({ where: roomFilter });
    await prisma.room.deleteMany({ where: roomFilter.room });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
    });
  }
  await app?.close();
});

describe('комнаты', () => {
  it('создаёт постоянную комнату, проверяет уникальность slug и не принимает ownerId', async () => {
    const owner = await createUser();
    const slug = `team-${randomUUID().slice(0, 8)}`;

    const room = await createRoom(owner, {
      name: '  Планёрка  ',
      slug: slug.toUpperCase(),
    });
    expect(room).toMatchObject({
      name: 'Планёрка',
      slug,
      type: 'PERMANENT',
      accessType: 'OPEN',
      status: 'ACTIVE',
      activeConference: null,
    });

    const duplicate = await api('POST', '/rooms', {
      headers: owner.auth,
      payload: { name: 'Дубль', slug },
    });
    expect(duplicate.statusCode).toBe(409);

    const injected = await api('POST', '/rooms', {
      headers: owner.auth,
      payload: { name: 'Чужая', ownerId: 1, status: 'ENDED' },
    });
    expect(injected.statusCode).toBe(400);

    const badSlug = await api('POST', '/rooms', {
      headers: owner.auth,
      payload: { name: 'Плохая', slug: 'плохой slug' },
    });
    expect(badSlug.statusCode).toBe(400);

    const generated = await createRoom(owner);
    expect(generated.slug).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);

    const anonymous = await api('POST', '/rooms', {
      payload: { name: 'Аноним' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('создаёт временную комнату со случайными названием и ссылкой', async () => {
    const owner = await createUser();

    const room = await createRoom(owner, {}, '/rooms/quick');

    expect(room.type).toBe('TEMPORARY');
    expect(room.name).toBe(`Встреча ${room.slug}`);
    expect(room.expiresAt).toEqual(expect.any(String));
  });

  it('показывает и меняет комнату только владельцу', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const room = await createRoom(owner);
    const other = await createRoom(owner);

    const list = await api('GET', '/rooms?page=1&limit=1', {
      headers: owner.auth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(list.json().items).toHaveLength(1);

    expect(
      (await api('GET', `/rooms/${room.id}`, { headers: stranger.auth }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api('PATCH', `/rooms/${room.id}`, {
          headers: stranger.auth,
          payload: { name: 'Взлом' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api('DELETE', `/rooms/${room.id}`, { headers: stranger.auth }))
        .statusCode,
    ).toBe(404);

    const updated = await api('PATCH', `/rooms/${room.id}`, {
      headers: owner.auth,
      payload: { name: 'Новое имя', accessType: 'CLOSED' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: 'Новое имя',
      accessType: 'CLOSED',
    });

    const conflict = await api('PATCH', `/rooms/${room.id}`, {
      headers: owner.auth,
      payload: { slug: other.slug },
    });
    expect(conflict.statusCode).toBe(409);

    const empty = await api('PATCH', `/rooms/${room.id}`, {
      headers: owner.auth,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('по ссылке отдаёт только публичные данные', async () => {
    const owner = await createUser();
    const room = await createRoom(owner, {
      name: 'Закрытая',
      accessType: 'CLOSED',
    });

    const guestView = await api('GET', `/rooms/by-slug/${room.slug}`);
    expect(guestView.statusCode).toBe(200);
    expect(guestView.json()).toEqual({
      name: 'Закрытая',
      slug: room.slug,
      type: 'PERMANENT',
      accessType: 'CLOSED',
      status: 'ACTIVE',
      hasActiveConference: false,
      canJoin: false,
    });

    const ownerView = await api('GET', `/rooms/by-slug/${room.slug}`, {
      headers: owner.auth,
    });
    expect(ownerView.json().canJoin).toBe(true);

    expect(
      (await api('GET', '/rooms/by-slug/no-such-room-slug')).statusCode,
    ).toBe(404);
  });
});

describe('подключение и выход', () => {
  it('подключает пользователя с нескольких устройств одним участником', async () => {
    const owner = await createUser('Организатор');
    const room = await createRoom(owner);

    const first = await join(room.slug, {
      headers: owner.auth,
      payload: { deviceType: 'DESKTOP' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody).toMatchObject({
      conferenceStatus: 'ACTIVE',
      role: 'HOST',
      guestToken: null,
      room: { slug: room.slug, canJoin: true },
    });
    expect(firstBody.room).not.toHaveProperty('id');

    const second = await join(room.slug, {
      headers: { ...owner.auth, 'user-agent': 'Mozilla/5.0 (iPhone) Mobile' },
    });
    const secondBody = second.json();
    expect(secondBody.conferenceId).toBe(firstBody.conferenceId);
    expect(secondBody.participantId).toBe(firstBody.participantId);
    expect(secondBody.sessionId).not.toBe(firstBody.sessionId);

    const sessions = await prisma.conferenceParticipantSession.findMany({
      where: { participantId: firstBody.participantId },
      orderBy: { joinedAt: 'asc' },
    });
    expect(sessions.map((session) => session.deviceType)).toEqual([
      'DESKTOP',
      'MOBILE',
    ]);

    const participants = await api(
      'GET',
      `/conferences/${firstBody.conferenceId}/participants`,
      { headers: owner.auth },
    );
    expect(participants.statusCode).toBe(200);
    expect(participants.json().items).toEqual([
      expect.objectContaining({
        id: firstBody.participantId,
        displayName: 'Организатор',
        isGuest: false,
        role: 'HOST',
        activeSessionsCount: 2,
        isMe: true,
      }),
    ]);
  });

  it('выдаёт гостю подписанный токен и не доверяет guestId от клиента', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);

    expect((await join(room.slug)).statusCode).toBe(400);
    expect(
      (
        await join(room.slug, {
          payload: { guestName: 'Гость', guestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);

    const first = await join(room.slug, { payload: { guestName: 'Пётр' } });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.role).toBe('PARTICIPANT');
    expect(firstBody.guestToken).toEqual(expect.any(String));

    const sameGuest = await join(room.slug, {
      headers: { 'x-guest-token': firstBody.guestToken },
      payload: { guestName: 'Пётр' },
    });
    expect(sameGuest.json().participantId).toBe(firstBody.participantId);

    const forged = await join(room.slug, {
      headers: { 'x-guest-token': `${firstBody.guestToken}x` },
      payload: { guestName: 'Пётр' },
    });
    expect(forged.json().participantId).not.toBe(firstBody.participantId);

    const forgedRead = await api(
      'GET',
      `/conferences/${firstBody.conferenceId}`,
      { headers: { 'x-guest-token': 'forged' } },
    );
    expect(forgedRead.statusCode).toBe(401);

    const guestRead = await api(
      'GET',
      `/conferences/${firstBody.conferenceId}`,
      { headers: { 'x-guest-token': firstBody.guestToken } },
    );
    expect(guestRead.statusCode).toBe(200);
    expect(guestRead.json()).toMatchObject({
      myParticipantId: firstBody.participantId,
      isOrganizer: false,
      participantsCount: 2,
    });
  });

  it('не пускает в закрытую комнату никого, кроме организатора', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const room = await createRoom(owner, {
      name: 'Закрытая',
      accessType: 'CLOSED',
    });

    expect(
      (await join(room.slug, { payload: { guestName: 'Гость' } })).statusCode,
    ).toBe(403);
    expect((await join(room.slug, { headers: stranger.auth })).statusCode).toBe(
      403,
    );
    expect((await join(room.slug, { headers: owner.auth })).statusCode).toBe(
      200,
    );
  });

  it('при параллельных подключениях создаёт одну конференцию', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        join(room.slug, { payload: { guestName: `Гость ${index}` } }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual(
      Array(8).fill(200),
    );
    expect(
      new Set(responses.map((response) => response.json().conferenceId)).size,
    ).toBe(1);
    expect(await prisma.conference.count({ where: { roomId: room.id } })).toBe(
      1,
    );
  });

  it('выход закрывает только одну сессию, последняя переводит конференцию в EMPTY', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const room = await createRoom(owner);
    const first = (await join(room.slug, { headers: owner.auth })).json();
    const second = (await join(room.slug, { headers: owner.auth })).json();

    expect(
      (
        await api('POST', `/conferences/sessions/${first.sessionId}/leave`, {
          headers: stranger.auth,
        })
      ).statusCode,
    ).toBe(404);

    const leaveFirst = await api(
      'POST',
      `/conferences/sessions/${first.sessionId}/leave`,
      { headers: owner.auth },
    );
    expect(leaveFirst.statusCode).toBe(200);
    expect(leaveFirst.json()).toMatchObject({
      sessionId: first.sessionId,
      conferenceStatus: 'ACTIVE',
    });

    const leaveSecond = await api(
      'POST',
      `/conferences/sessions/${second.sessionId}/leave`,
      { headers: owner.auth },
    );
    expect(leaveSecond.json().conferenceStatus).toBe('EMPTY');

    const repeated = await api(
      'POST',
      `/conferences/sessions/${second.sessionId}/leave`,
      { headers: owner.auth },
    );
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().leftAt).toBe(leaveSecond.json().leftAt);

    const emptyConference = await prisma.conference.findUniqueOrThrow({
      where: { id: first.conferenceId },
    });
    expect(emptyConference.status).toBe('EMPTY');
    expect(emptyConference.emptyAt).toBeInstanceOf(Date);

    const rejoin = await join(room.slug, { headers: owner.auth });
    expect(rejoin.json()).toMatchObject({
      conferenceId: first.conferenceId,
      conferenceStatus: 'ACTIVE',
    });
    const active = await prisma.conference.findUniqueOrThrow({
      where: { id: first.conferenceId },
    });
    expect(active.emptyAt).toBeNull();
  });
});

describe('окончание авторизации', () => {
  it('logout-all закрывает все подключения пользователя, конференция становится EMPTY', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const first = (await join(room.slug, { headers: owner.auth })).json();
    const second = (await join(room.slug, { headers: owner.auth })).json();

    const logout = await api('POST', '/auth/logout-all', {
      headers: owner.auth,
    });
    expect(logout.statusCode).toBe(204);

    expect(await sessionLeftAt(first.sessionId)).toBeInstanceOf(Date);
    expect(await sessionLeftAt(second.sessionId)).toBeInstanceOf(Date);
    const conference = await prisma.conference.findUniqueOrThrow({
      where: { id: first.conferenceId },
    });
    expect(conference.status).toBe('EMPTY');
    expect(conference.emptyAt).toBeInstanceOf(Date);
  });

  it('отзыв сессии другого устройства закрывает только его подключение', async () => {
    const owner = await createUser();
    const phone = await loginAgain(owner);
    const room = await createRoom(owner);
    const desktopJoin = (await join(room.slug, { headers: owner.auth })).json();
    const phoneJoin = (await join(room.slug, { headers: phone.auth })).json();
    const phoneAuthSession =
      await prisma.conferenceParticipantSession.findUniqueOrThrow({
        where: { id: phoneJoin.sessionId },
      });

    const revoke = await api(
      'DELETE',
      `/auth/sessions/${phoneAuthSession.authSessionId}`,
      { headers: owner.auth },
    );
    expect(revoke.statusCode).toBe(204);

    expect(await sessionLeftAt(phoneJoin.sessionId)).toBeInstanceOf(Date);
    expect(await sessionLeftAt(desktopJoin.sessionId)).toBeNull();
    expect(
      (
        await prisma.conference.findUniqueOrThrow({
          where: { id: desktopJoin.conferenceId },
        })
      ).status,
    ).toBe('ACTIVE');
  });

  it('планировщик закрывает подключения с истёкшей сессией авторизации', async () => {
    const owner = await createUser();
    const member = await createUser();
    const room = await createRoom(owner);
    const ownerJoin = (await join(room.slug, { headers: owner.auth })).json();
    const memberJoin = (await join(room.slug, { headers: member.auth })).json();
    const guestJoin = (
      await join(room.slug, { payload: { guestName: 'Гость' } })
    ).json();

    await prisma.authSession.updateMany({
      where: { userId: member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await scheduler.handleTick();

    expect(await sessionLeftAt(memberJoin.sessionId)).toBeInstanceOf(Date);
    expect(await sessionLeftAt(ownerJoin.sessionId)).toBeNull();
    expect(await sessionLeftAt(guestJoin.sessionId)).toBeNull();
    expect(
      (
        await api('POST', `/conferences/${memberJoin.conferenceId}/messages`, {
          headers: member.auth,
          payload: { content: 'Привет' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('завершение конференции', () => {
  it('автоматически завершает EMPTY-конференцию через 3 минуты вместе с временной комнатой', async () => {
    const owner = await createUser();
    const room = await createRoom(owner, {}, '/rooms/quick');
    const joined = (await join(room.slug, { headers: owner.auth })).json();
    await api('POST', `/conferences/sessions/${joined.sessionId}/leave`, {
      headers: owner.auth,
    });

    await scheduler.finishEmptyConferences();
    expect(
      (
        await prisma.conference.findUniqueOrThrow({
          where: { id: joined.conferenceId },
        })
      ).status,
    ).toBe('EMPTY');

    await prisma.conference.update({
      where: { id: joined.conferenceId },
      data: { emptyAt: new Date(Date.now() - 4 * 60_000) },
    });
    await scheduler.finishEmptyConferences();

    const conference = await prisma.conference.findUniqueOrThrow({
      where: { id: joined.conferenceId },
      include: { room: true },
    });
    expect(conference.status).toBe('ENDED');
    expect(conference.endedAt).toBeInstanceOf(Date);
    expect(conference.room.status).toBe('ENDED');

    expect((await join(room.slug, { headers: owner.auth })).statusCode).toBe(
      410,
    );
    expect(
      (await api('GET', `/rooms/by-slug/${room.slug}`)).json().canJoin,
    ).toBe(false);
  });

  it('завершает конференцию только организатор, сессии закрываются, повтор безопасен', async () => {
    const owner = await createUser();
    const member = await createUser();
    const room = await createRoom(owner, {}, '/rooms/quick');
    const hostJoin = (await join(room.slug, { headers: owner.auth })).json();
    await join(room.slug, { headers: member.auth });

    const forbidden = await api(
      'POST',
      `/conferences/${hostJoin.conferenceId}/end`,
      { headers: member.auth },
    );
    expect(forbidden.statusCode).toBe(403);

    const ended = await api(
      'POST',
      `/conferences/${hostJoin.conferenceId}/end`,
      { headers: owner.auth },
    );
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      status: 'ENDED',
      activeParticipantsCount: 0,
      participantsCount: 2,
      isOrganizer: true,
    });

    expect(
      await prisma.conferenceParticipantSession.count({
        where: {
          leftAt: null,
          participant: { conferenceId: hostJoin.conferenceId },
        },
      }),
    ).toBe(0);
    expect(
      (await prisma.room.findUniqueOrThrow({ where: { id: room.id } })).status,
    ).toBe('ENDED');

    const repeated = await api(
      'POST',
      `/conferences/${hostJoin.conferenceId}/end`,
      { headers: owner.auth },
    );
    expect(repeated.statusCode).toBe(200);
  });

  it('после завершения постоянной комнаты создаёт новую конференцию', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const first = (await join(room.slug, { headers: owner.auth })).json();
    await api('POST', `/conferences/${first.conferenceId}/end`, {
      headers: owner.auth,
    });

    const second = await join(room.slug, { headers: owner.auth });

    expect(second.statusCode).toBe(200);
    expect(second.json().conferenceId).not.toBe(first.conferenceId);
  });
});

describe('история и сообщения', () => {
  it('отдаёт историю владельцу и участникам, но не посторонним и гостям', async () => {
    const owner = await createUser();
    const member = await createUser();
    const stranger = await createUser();
    const room = await createRoom(owner);

    const first = (await join(room.slug, { headers: member.auth })).json();
    await api('POST', `/conferences/${first.conferenceId}/end`, {
      headers: owner.auth,
    });
    const second = (await join(room.slug, { headers: owner.auth })).json();
    await api('POST', `/conferences/${second.conferenceId}/end`, {
      headers: owner.auth,
    });

    const ownerHistory = await api('GET', `/rooms/${room.id}/conferences`, {
      headers: owner.auth,
    });
    expect(ownerHistory.statusCode).toBe(200);
    expect(ownerHistory.json().total).toBe(2);
    expect(ownerHistory.json().items[0].id).toBe(second.conferenceId);

    const memberHistory = await api('GET', `/rooms/${room.id}/conferences`, {
      headers: member.auth,
    });
    expect(memberHistory.json().items).toEqual([
      expect.objectContaining({ id: first.conferenceId, participantsCount: 1 }),
    ]);

    expect(
      (
        await api('GET', `/rooms/${room.id}/conferences`, {
          headers: stranger.auth,
        })
      ).statusCode,
    ).toBe(404);
    expect((await api('GET', `/rooms/${room.id}/conferences`)).statusCode).toBe(
      401,
    );
    expect(
      (
        await api('GET', `/conferences/${first.conferenceId}`, {
          headers: stranger.auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('принимает сообщения только от подключённых участников активной конференции', async () => {
    const owner = await createUser('Организатор');
    const room = await createRoom(owner);
    const host = (await join(room.slug, { headers: owner.auth })).json();
    const guest = (
      await join(room.slug, { payload: { guestName: 'Гость Пётр' } })
    ).json();
    const guestHeaders = { 'x-guest-token': guest.guestToken };
    const messagesUrl = `/conferences/${host.conferenceId}/messages`;

    const sent = await api('POST', messagesUrl, {
      headers: guestHeaders,
      payload: { content: '  Привет  ' },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({
      content: 'Привет',
      isMine: true,
      author: { displayName: 'Гость Пётр', isGuest: true },
    });

    for (let i = 0; i < 2; i += 1) {
      await api('POST', messagesUrl, {
        headers: owner.auth,
        payload: { content: `Сообщение ${i}` },
      });
    }

    expect(
      (
        await api('POST', messagesUrl, {
          headers: owner.auth,
          payload: { content: '   ' },
        })
      ).statusCode,
    ).toBe(400);

    const page = await api('GET', `${messagesUrl}?page=1&limit=2`, {
      headers: guestHeaders,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(
      page.json().items.map((m: { content: string }) => m.content),
    ).toEqual(['Сообщение 1', 'Сообщение 0']);

    await api('POST', `/conferences/sessions/${guest.sessionId}/leave`, {
      headers: guestHeaders,
    });
    expect(
      (
        await api('POST', messagesUrl, {
          headers: guestHeaders,
          payload: { content: 'Уже вышел' },
        })
      ).statusCode,
    ).toBe(403);

    await api('POST', `/conferences/${host.conferenceId}/end`, {
      headers: owner.auth,
    });
    expect(
      (
        await api('POST', messagesUrl, {
          headers: owner.auth,
          payload: { content: 'После завершения' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await api('GET', messagesUrl, { headers: guestHeaders })).statusCode,
    ).toBe(403);
    expect(
      (await api('GET', messagesUrl, { headers: owner.auth })).json().total,
    ).toBe(3);
  });

  it('удаление комнаты завершает конференцию и сохраняет историю', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const joined = (await join(room.slug, { headers: owner.auth })).json();

    const removed = await api('DELETE', `/rooms/${room.id}`, {
      headers: owner.auth,
    });
    expect(removed.statusCode).toBe(204);

    expect(
      (await api('DELETE', `/rooms/${room.id}`, { headers: owner.auth }))
        .statusCode,
    ).toBe(404);
    expect((await api('GET', `/rooms/by-slug/${room.slug}`)).statusCode).toBe(
      404,
    );
    expect((await join(room.slug, { headers: owner.auth })).statusCode).toBe(
      404,
    );
    expect(
      (await api('GET', '/rooms', { headers: owner.auth })).json().total,
    ).toBe(0);

    const history = await api('GET', `/rooms/${room.id}/conferences`, {
      headers: owner.auth,
    });
    expect(history.json().items).toEqual([
      expect.objectContaining({ id: joined.conferenceId, status: 'ENDED' }),
    ]);
  });
});
