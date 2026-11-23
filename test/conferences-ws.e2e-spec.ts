import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { ConferencePresenceService } from '../src/modules/conferences/conference-presence.service.js';
import { ConferenceSessionsService } from '../src/modules/conferences/conference-sessions.service.js';
import { ConferencesScheduler } from '../src/modules/conferences/conferences.scheduler.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-ws.vks.test';
const PASSWORD = 'correct-horse-battery';
const EVENT_TIMEOUT_MS = 3_000;

let app: NestFastifyApplication;
let prisma: PrismaService;
let presence: ConferencePresenceService;
let prefix: string;
let baseUrl: string;
let ipCounter = 0;
const sockets: Socket[] = [];

interface TestUser {
  id: number;
  email: string;
  accessToken: string;
  auth: { authorization: string };
}

interface JoinAck {
  conferenceId: string;
  conferenceStatus: string;
  participantId: string;
  sessionId: string;
  role: string;
  guestToken: string | null;
  error?: { statusCode: number; message: string | string[] };
}

interface StateParticipant {
  id: string;
  userId: number | null;
  guestId: string | null;
  name: string;
  role: string;
  connectionsCount: number;
}

interface ConferenceState {
  conferenceId: string;
  roomId: string;
  status: string;
  participants: StateParticipant[];
  participantsCount: number;
}

function nextIp(): string {
  ipCounter += 1;
  return `10.2.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function api(
  method: 'GET' | 'POST' | 'DELETE',
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

async function createUser(name = 'Тест'): Promise<TestUser> {
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const body = (
    await api('POST', '/auth/register', {
      payload: { email, password: PASSWORD, name },
    })
  ).json();

  return {
    id: body.user.id,
    email,
    accessToken: body.accessToken,
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

async function createRoom(owner: TestUser, payload: object = {}) {
  const response = await api('POST', '/rooms', {
    headers: owner.auth,
    payload: { name: 'Комната', ...payload },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

function connect(
  auth: Record<string, string> = {},
  extraHeaders?: Record<string, string>,
): Promise<Socket> {
  const socket = io(`${baseUrl}/conferences`, {
    auth,
    extraHeaders,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitFor<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Не дождались события ${event}`)),
      EVENT_TIMEOUT_MS,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Ждёт, что событие не придёт за короткое время. */
async function expectNoEvent(socket: Socket, event: string): Promise<void> {
  let received = false;
  const listener = () => {
    received = true;
  };
  socket.on(event, listener);
  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.off(event, listener);
  expect(received).toBe(false);
}

async function joinWs(
  socket: Socket,
  payload: object,
): Promise<{ ack: JoinAck; state: ConferenceState }> {
  const state = waitFor<ConferenceState>(socket, 'conference:state');
  const ack: JoinAck = await socket
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('conference:join', payload);

  if (ack.error) {
    state.catch(() => undefined);
    throw Object.assign(new Error('join failed'), { ack });
  }

  return { ack, state: await state };
}

async function joinError(socket: Socket, payload: object) {
  const ack: JoinAck = await socket
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('conference:join', payload);

  return ack.error;
}

function openSessions(participantId: string): Promise<number> {
  return prisma.conferenceParticipantSession.count({
    where: { participantId, leftAt: null },
  });
}

async function conferenceStatus(conferenceId: string): Promise<string> {
  return (
    await prisma.conference.findUniqueOrThrow({ where: { id: conferenceId } })
  ).status;
}

/** Обработка disconnect на сервере асинхронна — ждём, пока сокет исчезнет из присутствия. */
async function waitUntil(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error('Условие не выполнилось вовремя');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  prisma = app.get(PrismaService);
  presence = app.get(ConferencePresenceService);
  prefix = process.env.API_PREFIX!.replace(/^\/+|\/+$/g, '');
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await app?.close();

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
});

describe('подключение по WebSocket', () => {
  it('отклоняет недействительный access token и чужой Origin', async () => {
    await expect(connect({ token: 'garbage' })).rejects.toMatchObject({
      message: 'Недействительный access token',
      data: { statusCode: 401 },
    });
    await expect(
      connect({}, { origin: 'http://evil.example' }),
    ).rejects.toBeInstanceOf(Error);

    const sameOrigin = await connect({}, { origin: baseUrl });
    expect(sameOrigin.connected).toBe(true);
  });

  it('валидирует payload и не пускает в закрытую комнату', async () => {
    const owner = await createUser();
    const room = await createRoom(owner, { accessType: 'CLOSED' });
    const guest = await connect();

    expect(await joinError(guest, { slug: 'Bad slug!' })).toMatchObject({
      statusCode: 400,
    });
    expect(
      await joinError(guest, { slug: room.slug, guestName: 'Гость', x: 1 }),
    ).toMatchObject({ statusCode: 400 });
    expect(await joinError(guest, { slug: room.slug })).toMatchObject({
      statusCode: 400,
      message: 'Гостю нужно указать имя',
    });
    expect(
      await joinError(guest, { slug: room.slug, guestName: 'Гость' }),
    ).toMatchObject({ statusCode: 403 });
    expect(
      await joinError(guest, { slug: 'missing-room-slug', guestName: 'Гость' }),
    ).toMatchObject({ statusCode: 404 });

    const ownerSocket = await connect({ token: owner.accessToken });
    const { ack, state } = await joinWs(ownerSocket, { slug: room.slug });
    expect(ack.role).toBe('HOST');
    expect(state.participants).toHaveLength(1);
  });

  it('повторный join того же сокета, в том числе параллельный, не создаёт новых сессий', async () => {
    const owner = await createUser('Организатор');
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });

    const [first, second] = await Promise.all([
      joinWs(socket, { slug: room.slug }),
      joinWs(socket, { slug: room.slug }),
    ]);
    const third = await joinWs(socket, { slug: room.slug });

    expect(second.ack.sessionId).toBe(first.ack.sessionId);
    expect(third.ack.sessionId).toBe(first.ack.sessionId);
    expect(await openSessions(first.ack.participantId)).toBe(1);
    expect(third.state).toMatchObject({
      conferenceId: first.ack.conferenceId,
      roomId: room.id,
      status: 'ACTIVE',
      participantsCount: 1,
      participants: [
        {
          id: first.ack.participantId,
          userId: owner.id,
          guestId: null,
          name: 'Организатор',
          role: 'HOST',
          connectionsCount: 1,
        },
      ],
    });
  });

  it('несколько устройств — один участник; устройства отключаются независимо', async () => {
    const owner = await createUser('Организатор');
    const member = await createUser('Участник');
    const room = await createRoom(owner);
    const ownerSocket = await connect({ token: owner.accessToken });
    const { ack: ownerAck } = await joinWs(ownerSocket, { slug: room.slug });

    const desktop = await connect({ token: member.accessToken });
    const joined = waitFor<any>(ownerSocket, 'participant:joined');
    const { ack: desktopAck } = await joinWs(desktop, { slug: room.slug });
    expect(await joined).toMatchObject({
      conferenceId: ownerAck.conferenceId,
      participantsCount: 2,
      participant: { id: desktopAck.participantId, connectionsCount: 1 },
    });

    const phone = await connect({ token: member.accessToken });
    const updated = waitFor<any>(ownerSocket, 'participant:updated');
    const { ack: phoneAck, state } = await joinWs(phone, { slug: room.slug });
    expect(phoneAck.participantId).toBe(desktopAck.participantId);
    expect(phoneAck.sessionId).not.toBe(desktopAck.sessionId);
    expect(await updated).toMatchObject({
      participantsCount: 2,
      participant: { id: desktopAck.participantId, connectionsCount: 2 },
    });
    expect(state.participantsCount).toBe(2);
    expect(
      state.participants.find((p) => p.id === desktopAck.participantId),
    ).toMatchObject({ connectionsCount: 2, name: 'Участник' });

    const afterPhoneLeft = waitFor<any>(ownerSocket, 'participant:updated');
    phone.disconnect();
    expect(await afterPhoneLeft).toMatchObject({
      participant: { id: desktopAck.participantId, connectionsCount: 1 },
    });
    await waitUntil(
      async () => (await openSessions(desktopAck.participantId)) === 1,
    );

    const left = waitFor<any>(ownerSocket, 'participant:left');
    expect(
      await desktop.timeout(EVENT_TIMEOUT_MS).emitWithAck('conference:leave'),
    ).toEqual({ left: true });
    expect(await left).toEqual({
      conferenceId: ownerAck.conferenceId,
      participantId: desktopAck.participantId,
      participantsCount: 1,
    });
    expect(await openSessions(desktopAck.participantId)).toBe(0);
    expect(await conferenceStatus(ownerAck.conferenceId)).toBe('ACTIVE');
  });

  it('последний вышедший переводит конференцию в EMPTY, повторный вход возвращает ACTIVE', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const first = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(first, { slug: room.slug });

    first.disconnect();
    await waitUntil(
      async () => (await conferenceStatus(ack.conferenceId)) === 'EMPTY',
    );
    const empty = await prisma.conference.findUniqueOrThrow({
      where: { id: ack.conferenceId },
    });
    expect(empty.emptyAt).toBeInstanceOf(Date);
    expect(presence.participantsCount(ack.conferenceId)).toBe(0);

    const second = await connect({ token: owner.accessToken });
    const { ack: rejoin, state } = await joinWs(second, { slug: room.slug });
    expect(rejoin.conferenceId).toBe(ack.conferenceId);
    expect(rejoin.participantId).toBe(ack.participantId);
    expect(state.status).toBe('ACTIVE');
    expect(
      (
        await prisma.conference.findUniqueOrThrow({
          where: { id: ack.conferenceId },
        })
      ).emptyAt,
    ).toBeNull();
  });

  it('гость переподключается по гостевому токену тем же участником', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const first = await connect();
    const { ack } = await joinWs(first, { slug: room.slug, guestName: 'Пётр' });
    expect(ack.guestToken).toEqual(expect.any(String));
    first.disconnect();

    const second = await connect({ guestToken: ack.guestToken! });
    const { ack: again, state } = await joinWs(second, {
      slug: room.slug,
      guestName: 'Пётр Иванов',
    });
    expect(again.participantId).toBe(ack.participantId);
    expect(state.participants).toMatchObject([
      { id: ack.participantId, userId: null, name: 'Пётр Иванов' },
    ]);
    expect(state.participants[0].guestId).toEqual(expect.any(String));

    const stranger = await connect({ guestToken: 'forged' });
    const { ack: other } = await joinWs(stranger, {
      slug: room.slug,
      guestName: 'Чужой',
    });
    expect(other.participantId).not.toBe(ack.participantId);
  });
});

describe('интеграция с REST', () => {
  it('рассылает message:created с isMine для каждого получателя', async () => {
    const owner = await createUser();
    const member = await createUser();
    const room = await createRoom(owner);
    const ownerSocket = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(ownerSocket, { slug: room.slug });
    const memberSocket = await connect({ token: member.accessToken });
    await joinWs(memberSocket, { slug: room.slug });

    const forOwner = waitFor<any>(ownerSocket, 'message:created');
    const forMember = waitFor<any>(memberSocket, 'message:created');
    const response = await api(
      'POST',
      `/conferences/${ack.conferenceId}/messages`,
      { headers: owner.auth, payload: { content: 'Всем привет' } },
    );
    expect(response.statusCode).toBe(201);

    expect(await forOwner).toMatchObject({
      id: response.json().id,
      conferenceId: ack.conferenceId,
      content: 'Всем привет',
      isMine: true,
    });
    expect(await forMember).toMatchObject({
      id: response.json().id,
      isMine: false,
    });
  });

  it('завершение конференции через REST рассылает conference:ended и закрывает сессии', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const ownerSocket = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(ownerSocket, { slug: room.slug });
    const guestSocket = await connect();
    const { ack: guestAck } = await joinWs(guestSocket, {
      slug: room.slug,
      guestName: 'Гость',
    });

    const ended = waitFor<any>(guestSocket, 'conference:ended');
    const response = await api('POST', `/conferences/${ack.conferenceId}/end`, {
      headers: owner.auth,
    });
    expect(response.statusCode).toBe(200);
    expect(await ended).toMatchObject({
      conferenceId: ack.conferenceId,
      status: 'ENDED',
    });
    expect(await openSessions(guestAck.participantId)).toBe(0);
    expect(presence.participantsCount(ack.conferenceId)).toBe(0);

    expect(
      await guestSocket
        .timeout(EVENT_TIMEOUT_MS)
        .emitWithAck('conference:leave'),
    ).toEqual({ left: false });

    const { ack: next } = await joinWs(ownerSocket, { slug: room.slug });
    expect(next.conferenceId).not.toBe(ack.conferenceId);
  });

  it('удаление комнаты рассылает conference:ended', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(socket, { slug: room.slug });

    const ended = waitFor<any>(socket, 'conference:ended');
    expect(
      (await api('DELETE', `/rooms/${room.id}`, { headers: owner.auth }))
        .statusCode,
    ).toBe(204);
    expect(await ended).toMatchObject({ conferenceId: ack.conferenceId });
  });

  it('logout-all отключает сокеты пользователя, остальные получают participant:left', async () => {
    const owner = await createUser();
    const member = await createUser();
    const room = await createRoom(owner);
    const ownerSocket = await connect({ token: owner.accessToken });
    await joinWs(ownerSocket, { slug: room.slug });
    const memberSocket = await connect({ token: member.accessToken });
    const { ack: memberAck } = await joinWs(memberSocket, { slug: room.slug });

    const left = waitFor<any>(ownerSocket, 'participant:left');
    const disconnected = waitFor<string>(memberSocket, 'disconnect');
    expect(
      (await api('POST', '/auth/logout-all', { headers: member.auth }))
        .statusCode,
    ).toBe(204);

    expect(await left).toMatchObject({
      participantId: memberAck.participantId,
    });
    expect(await disconnected).toBe('io server disconnect');
    expect(await openSessions(memberAck.participantId)).toBe(0);
  });

  it('выход через REST по sessionId WebSocket-подключения отключает этот сокет', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(socket, { slug: room.slug });

    const disconnected = waitFor<string>(socket, 'disconnect');
    const response = await api(
      'POST',
      `/conferences/sessions/${ack.sessionId}/leave`,
      { headers: owner.auth },
    );
    expect(response.json().conferenceStatus).toBe('EMPTY');
    expect(await disconnected).toBe('io server disconnect');
    expect(presence.get(socket.id ?? '')).toBeUndefined();
  });
});

describe('надёжность', () => {
  it('после перезапуска закрывает зависшие подключения', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const rest = (
      await api('POST', `/rooms/by-slug/${room.slug}/join`, {
        headers: owner.auth,
        payload: {},
      })
    ).json();

    await prisma.conferenceParticipantSession.update({
      where: { id: rest.sessionId },
      data: { joinedAt: new Date(Date.now() - 60 * 60_000) },
    });
    await app.get(ConferenceSessionsService).onApplicationBootstrap();

    const session = await prisma.conferenceParticipantSession.findUniqueOrThrow(
      { where: { id: rest.sessionId } },
    );
    expect(session.leftAt).toBeInstanceOf(Date);
    expect(await conferenceStatus(rest.conferenceId)).toBe('EMPTY');
  });

  it('автозавершение EMPTY-конференции не трогает подключённых и рассылает conference:ended', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const { ack } = await joinWs(socket, { slug: room.slug });

    await expectNoEvent(socket, 'conference:ended');
    await app
      .get(ConferencesScheduler)
      .finishEmptyConferences(new Date(Date.now() + 10 * 60_000));
    expect(await conferenceStatus(ack.conferenceId)).toBe('ACTIVE');

    await socket.timeout(EVENT_TIMEOUT_MS).emitWithAck('conference:leave');
    expect(await conferenceStatus(ack.conferenceId)).toBe('EMPTY');

    const watcher = await connect({ token: owner.accessToken });
    await app
      .get(ConferencesScheduler)
      .finishEmptyConferences(new Date(Date.now() + 10 * 60_000));
    expect(await conferenceStatus(ack.conferenceId)).toBe('ENDED');
    expect(watcher.connected).toBe(true);
  });
});
