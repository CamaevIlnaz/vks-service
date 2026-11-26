import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { AccessToken } from 'livekit-server-sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as Y from 'yjs';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { UserStatus } from '../src/generated/prisma/client.js';
import { LivekitService } from '../src/modules/media/livekit.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-members.vks.test';
const PASSWORD = 'correct-horse-battery';
const EVENT_TIMEOUT_MS = 3_000;

let app: NestFastifyApplication;
let prisma: PrismaService;
let livekit: LivekitService;
let prefix: string;
let baseUrl: string;
let ipCounter = 0;
const sockets: Socket[] = [];
const editors: HocuspocusProvider[] = [];

interface TestUser {
  id: number;
  email: string;
  name: string;
  accessToken: string;
  auth: { authorization: string };
}

interface JoinAck {
  conferenceId: string;
  participantId: string;
  sessionId: string;
  role: string;
  error?: { statusCode: number; message: string | string[] };
}

function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
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
    name,
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

function connect(auth: Record<string, string> = {}): Promise<Socket> {
  const socket = io(`${baseUrl}/conferences`, {
    auth,
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

function waitForDisconnect(socket: Socket): Promise<void> {
  if (socket.disconnected) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Сокет не отключился')),
      EVENT_TIMEOUT_MS,
    );

    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function joinWs(socket: Socket, payload: object): Promise<JoinAck> {
  const ack: JoinAck = await socket
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('conference:join', payload);

  if (ack.error) {
    throw Object.assign(new Error('join failed'), { ack });
  }

  return ack;
}

async function joinError(socket: Socket, payload: object) {
  const ack: JoinAck = await socket
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('conference:join', payload);

  return ack.error;
}

function connectEditor(url: string, documentId: string, token: string) {
  const doc = new Y.Doc();

  return new Promise<HocuspocusProvider>((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider?.destroy();
      reject(new Error('Документ не синхронизировался'));
    }, 8_000);
    const provider = new HocuspocusProvider({
      url,
      name: `document:${documentId}`,
      token,
      document: doc,
      onSynced() {
        clearTimeout(timeout);
        editors.push(provider);
        resolve(provider);
      },
      onAuthenticationFailed({ reason }) {
        clearTimeout(timeout);
        provider.destroy();
        reject(new Error(reason || 'Доступ запрещён'));
      },
    });
  });
}

function waitUntilEditorClosed(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Редактор не отключился')),
      8_000,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };

    provider.on('close', done);
    provider.on('disconnect', done);
    provider.on('authenticationFailed', done);
  });
}

async function signWebhook(body: string): Promise<string> {
  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { ttl: 60 },
  );

  token.sha256 = createHash('sha256').update(body).digest('base64');

  return token.toJwt();
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
  livekit = app.get(LivekitService);
  prefix = process.env.API_PREFIX!.replace(/^\/+|\/+$/g, '');

  vi.spyOn(livekit, 'removeParticipant').mockResolvedValue(undefined);
  vi.spyOn(livekit, 'listParticipants').mockResolvedValue([]);
  vi.spyOn(livekit, 'deleteRoom').mockResolvedValue(undefined);
});

afterEach(() => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }

  for (const provider of editors.splice(0)) {
    provider.destroy();
  }
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await app?.close();
  vi.restoreAllMocks();

  if (prisma) {
    const roomFilter = {
      room: { owner: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
    };

    await prisma.conferenceDocument.deleteMany({
      where: { document: roomFilter },
    });
    await prisma.roomDocument.deleteMany({ where: roomFilter });
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
    await prisma.roomMember.deleteMany({
      where: { room: { owner: { email: { endsWith: `@${EMAIL_DOMAIN}` } } } },
    });
    await prisma.room.deleteMany({ where: roomFilter.room });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
    });
  }
});

describe('список допуска', () => {
  it('владелец добавляет, ищет и не может добавить себя или чужого повторно', async () => {
    const owner = await createUser('Владелец Комнат');
    const member = await createUser(`Участник ${randomUUID()}`);
    const blocked = await createUser(`Блок ${randomUUID()}`);
    const stranger = await createUser('Чужой');
    const room = await createRoom(owner, { accessType: 'CLOSED' });

    await prisma.user.update({
      where: { id: blocked.id },
      data: { status: UserStatus.BLOCKED },
    });

    const byName = await api('GET', '/users', { headers: owner.auth });
    const search = await api(
      'GET',
      `/users?search=${encodeURIComponent(member.name)}`,
      { headers: owner.auth },
    );
    const blockedSearch = await api(
      'GET',
      `/users?search=${encodeURIComponent(blocked.name)}`,
      { headers: owner.auth },
    );

    expect(byName.statusCode).toBe(400);
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toEqual([
      expect.objectContaining({
        id: member.id,
        email: member.email,
        name: member.name,
      }),
    ]);
    expect(search.json().items[0]).not.toHaveProperty('passwordHash');
    expect(blockedSearch.json().items).toEqual([]);

    const byEmail = await api(
      'GET',
      `/users?search=${encodeURIComponent(member.email)}`,
      { headers: owner.auth },
    );

    expect(byEmail.json().items.map((user: { id: number }) => user.id)).toEqual(
      [member.id],
    );

    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: stranger.auth,
          payload: { userId: member.id },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: owner.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: blocked.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: 2_000_000_000 },
        })
      ).statusCode,
    ).toBe(404);

    const [first, second] = await Promise.all([
      api('POST', `/rooms/${room.id}/members`, {
        headers: owner.auth,
        payload: { userId: member.id },
      }),
      api('POST', `/rooms/${room.id}/members`, {
        headers: owner.auth,
        payload: { userId: member.id },
      }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();

    expect(statuses).toEqual([201, 409]);

    const created = [first, second].find(
      (response) => response.statusCode === 201,
    );

    expect(created?.json()).toMatchObject({
      user: { id: member.id, email: member.email, name: member.name },
      addedById: owner.id,
    });
    expect(created?.json()).not.toHaveProperty('userId');

    const list = await api('GET', `/rooms/${room.id}/members`, {
      headers: owner.auth,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: member.id }),
        addedById: owner.id,
      }),
    ]);
    expect(
      list
        .json()
        .items.some(
          (item: { user: { id: number } }) => item.user.id === owner.id,
        ),
    ).toBe(false);
    expect(
      (
        await api('GET', `/rooms/${room.id}/members`, {
          headers: member.auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api('DELETE', `/rooms/${room.id}/members/${stranger.id}`, {
          headers: owner.auth,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api('DELETE', `/rooms/${room.id}/members/${member.id}`, {
          headers: stranger.auth,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('подключение к закрытой комнате', () => {
  it('пускает только владельца и добавленных пользователей', async () => {
    const owner = await createUser('Организатор');
    const member = await createUser('Допущенный');
    const stranger = await createUser('Посторонний');
    const room = await createRoom(owner, {
      name: 'Закрытая',
      accessType: 'CLOSED',
    });
    const ownRoom = await createRoom(member, { name: 'Своя' });

    expect(
      (
        await api('POST', `/rooms/by-slug/${room.slug}/join`, {
          headers: member.auth,
        })
      ).statusCode,
    ).toBe(403);

    const added = await api('POST', `/rooms/${room.id}/members`, {
      headers: owner.auth,
      payload: { userId: member.id },
    });

    expect(added.statusCode).toBe(201);

    const memberView = await api('GET', `/rooms/by-slug/${room.slug}`, {
      headers: member.auth,
    });
    const strangerView = await api('GET', `/rooms/by-slug/${room.slug}`, {
      headers: stranger.auth,
    });
    const guestView = await api('GET', `/rooms/by-slug/${room.slug}`);

    expect(memberView.json().canJoin).toBe(true);
    expect(strangerView.json().canJoin).toBe(false);
    expect(guestView.json().canJoin).toBe(false);

    const memberJoin = await api('POST', `/rooms/by-slug/${room.slug}/join`, {
      headers: member.auth,
    });
    const strangerJoin = await api('POST', `/rooms/by-slug/${room.slug}/join`, {
      headers: stranger.auth,
    });
    const guestJoin = await api('POST', `/rooms/by-slug/${room.slug}/join`, {
      payload: { guestName: 'Гость' },
    });

    expect(memberJoin.statusCode).toBe(200);
    expect(memberJoin.json().role).toBe('PARTICIPANT');
    expect(strangerJoin.statusCode).toBe(403);
    expect(guestJoin.statusCode).toBe(403);

    const rooms = await api('GET', '/rooms', { headers: member.auth });
    const ids = rooms.json().items.map((item: { id: string }) => item.id);

    expect(rooms.statusCode).toBe(200);
    expect(ids).toEqual(expect.arrayContaining([room.id, ownRoom.id]));
    expect(
      (await api('GET', `/rooms/${room.id}`, { headers: member.auth }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await api('GET', `/rooms/${room.id}/documents`, {
          headers: member.auth,
        })
      ).statusCode,
    ).toBe(404);

    const memberSocket = await connect({ token: member.accessToken });
    const again = await joinWs(memberSocket, { slug: room.slug });

    expect(again.participantId).toBe(memberJoin.json().participantId);

    const strangerSocket = await connect({ token: stranger.accessToken });

    expect(await joinError(strangerSocket, { slug: room.slug })).toMatchObject({
      statusCode: 403,
    });
  });
});

describe('отзыв доступа', () => {
  it('удаление из закрытой комнаты отключает участника и сохраняет историю', async () => {
    const owner = await createUser('Организатор');
    const member = await createUser('Участник');
    const room = await createRoom(owner, { accessType: 'CLOSED' });

    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: member.id },
        })
      ).statusCode,
    ).toBe(201);

    const document = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title: 'Протокол' },
      })
    ).json();
    const ownerSocket = await connect({ token: owner.accessToken });
    const memberSocket = await connect({ token: member.accessToken });
    const ownerJoin = await joinWs(ownerSocket, { slug: room.slug });
    const memberJoin = await joinWs(memberSocket, { slug: room.slug });

    expect(
      (
        await api('POST', `/conferences/${ownerJoin.conferenceId}/documents`, {
          headers: owner.auth,
          payload: { documentId: document.id },
        })
      ).statusCode,
    ).toBe(201);

    const message = await api(
      'POST',
      `/conferences/${memberJoin.conferenceId}/messages`,
      { headers: member.auth, payload: { content: 'Я на месте' } },
    );
    const access = await api(
      'POST',
      `/rooms/${room.id}/documents/${document.id}/access`,
      { headers: member.auth },
    );
    const media = await api('POST', '/media/token', {
      headers: member.auth,
      payload: { sessionId: memberJoin.sessionId },
    });

    expect(message.statusCode).toBe(201);
    expect(access.statusCode).toBe(200);
    expect(media.statusCode).toBe(200);

    const editor = await connectEditor(
      access.json().url,
      document.id,
      access.json().token,
    );
    const editorClosed = waitUntilEditorClosed(editor);
    const left = waitFor<{ participantId: string }>(
      ownerSocket,
      'participant:left',
    );
    const disconnected = waitForDisconnect(memberSocket);

    vi.mocked(livekit.removeParticipant).mockClear();

    const removed = await api(
      'DELETE',
      `/rooms/${room.id}/members/${member.id}`,
      { headers: owner.auth },
    );

    expect(removed.statusCode).toBe(204);
    expect((await left).participantId).toBe(memberJoin.participantId);
    await disconnected;
    await editorClosed;
    expect(ownerSocket.connected).toBe(true);
    expect(livekit.removeParticipant).toHaveBeenCalledWith(
      memberJoin.conferenceId,
      memberJoin.sessionId,
    );

    const session = await prisma.conferenceParticipantSession.findUniqueOrThrow(
      {
        where: { id: memberJoin.sessionId },
      },
    );
    const participant = await prisma.conferenceParticipant.findUniqueOrThrow({
      where: { id: memberJoin.participantId },
    });
    const storedMessage = await prisma.conferenceMessage.findUniqueOrThrow({
      where: { id: message.json().id },
    });

    expect(session.leftAt).toEqual(expect.any(Date));
    expect(participant.userId).toBe(member.id);
    expect(storedMessage.content).toBe('Я на месте');

    expect(
      (
        await api('POST', `/rooms/by-slug/${room.slug}/join`, {
          headers: member.auth,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api('POST', '/media/token', {
          headers: member.auth,
          payload: { sessionId: memberJoin.sessionId },
        })
      ).statusCode,
    ).toBe(403);
    await expect(
      connectEditor(access.json().url, document.id, access.json().token),
    ).rejects.toThrow();

    const reconnect = await connect({ token: member.accessToken });

    expect(await joinError(reconnect, { slug: room.slug })).toMatchObject({
      statusCode: 403,
    });

    const history = await api('GET', `/rooms/${room.id}/conferences`, {
      headers: member.auth,
    });
    const messages = await api(
      'GET',
      `/conferences/${memberJoin.conferenceId}/messages`,
      { headers: member.auth },
    );
    const rooms = await api('GET', '/rooms', { headers: member.auth });

    expect(history.statusCode).toBe(200);
    expect(history.json().total).toBe(1);
    expect(messages.statusCode).toBe(200);
    expect(messages.json().items[0].content).toBe('Я на месте');
    expect(
      rooms.json().items.some((item: { id: string }) => item.id === room.id),
    ).toBe(false);

    vi.mocked(livekit.removeParticipant).mockClear();

    const webhookBody = JSON.stringify({
      event: 'participant_joined',
      id: randomUUID(),
      createdAt: '1700000000',
      room: { sid: 'RM_test', name: memberJoin.conferenceId },
      participant: {
        sid: 'PA_test',
        identity: memberJoin.sessionId,
        name: member.name,
      },
    });
    const webhook = await app.inject({
      method: 'POST',
      url: `/${prefix}/media/livekit/webhook`,
      remoteAddress: nextIp(),
      headers: {
        'content-type': 'application/webhook+json',
        authorization: await signWebhook(webhookBody),
      },
      payload: webhookBody,
    });

    expect(webhook.statusCode).toBe(200);
    expect(livekit.removeParticipant).toHaveBeenCalledWith(
      memberJoin.conferenceId,
      memberJoin.sessionId,
    );
  });

  it('при закрытии комнаты оставляет только владельца и допущенных', async () => {
    const owner = await createUser('Организатор');
    const member = await createUser('Допущенный');
    const outsider = await createUser('Случайный');
    const room = await createRoom(owner, { accessType: 'OPEN' });

    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: member.id },
        })
      ).statusCode,
    ).toBe(201);

    const ownerSocket = await connect({ token: owner.accessToken });
    const memberSocket = await connect({ token: member.accessToken });
    const outsiderSocket = await connect({ token: outsider.accessToken });
    const guestSocket = await connect();

    await joinWs(ownerSocket, { slug: room.slug });
    const memberJoin = await joinWs(memberSocket, { slug: room.slug });
    const outsiderJoin = await joinWs(outsiderSocket, { slug: room.slug });
    const guestJoin = await joinWs(guestSocket, {
      slug: room.slug,
      guestName: 'Гость',
    });
    const outsiderGone = waitForDisconnect(outsiderSocket);
    const guestGone = waitForDisconnect(guestSocket);
    const updated = await api('PATCH', `/rooms/${room.id}`, {
      headers: owner.auth,
      payload: { accessType: 'CLOSED' },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().accessType).toBe('CLOSED');
    await outsiderGone;
    await guestGone;
    expect(ownerSocket.connected).toBe(true);
    expect(memberSocket.connected).toBe(true);

    const memberSession =
      await prisma.conferenceParticipantSession.findUniqueOrThrow({
        where: { id: memberJoin.sessionId },
      });
    const outsiderSession =
      await prisma.conferenceParticipantSession.findUniqueOrThrow({
        where: { id: outsiderJoin.sessionId },
      });
    const guestSession =
      await prisma.conferenceParticipantSession.findUniqueOrThrow({
        where: { id: guestJoin.sessionId },
      });

    expect(memberSession.leftAt).toBeNull();
    expect(outsiderSession.leftAt).toEqual(expect.any(Date));
    expect(guestSession.leftAt).toEqual(expect.any(Date));
    expect(
      await prisma.conferenceParticipant.count({
        where: { id: outsiderJoin.participantId },
      }),
    ).toBe(1);

    const guestAgain = await connect();

    expect(
      await joinError(guestAgain, { slug: room.slug, guestName: 'Гость' }),
    ).toMatchObject({ statusCode: 403 });
    expect(
      (
        await api('POST', `/rooms/by-slug/${room.slug}/join`, {
          headers: outsider.auth,
        })
      ).statusCode,
    ).toBe(403);

    const stillThere = await joinWs(memberSocket, { slug: room.slug });

    expect(stillThere.sessionId).toBe(memberJoin.sessionId);
  });

  it('удаление из открытой комнаты не обрывает текущее подключение', async () => {
    const owner = await createUser('Организатор');
    const member = await createUser('Участник');
    const room = await createRoom(owner);

    expect(
      (
        await api('POST', `/rooms/${room.id}/members`, {
          headers: owner.auth,
          payload: { userId: member.id },
        })
      ).statusCode,
    ).toBe(201);

    const joined = (
      await api('POST', `/rooms/by-slug/${room.slug}/join`, {
        headers: member.auth,
      })
    ).json();
    const removed = await api(
      'DELETE',
      `/rooms/${room.id}/members/${member.id}`,
      { headers: owner.auth },
    );
    const session = await prisma.conferenceParticipantSession.findUniqueOrThrow(
      {
        where: { id: joined.sessionId },
      },
    );

    expect(removed.statusCode).toBe(204);
    expect(session.leftAt).toBeNull();
    expect(
      (
        await api('POST', `/rooms/by-slug/${room.slug}/join`, {
          headers: member.auth,
        })
      ).statusCode,
    ).toBe(200);
  });
});
