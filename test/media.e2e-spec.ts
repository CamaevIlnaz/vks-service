import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { AccessToken, Room, TokenVerifier } from 'livekit-server-sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { GUEST_TOKEN_HEADER } from '../src/modules/conferences/guest-tokens.service.js';
import { LivekitService } from '../src/modules/media/livekit.service.js';
import { MediaPresenceService } from '../src/modules/media/media-presence.service.js';
import { MediaService } from '../src/modules/media/media.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-media.vks.test';
const PASSWORD = 'correct-horse-battery';
const EVENT_TIMEOUT_MS = 3_000;

let app: NestFastifyApplication;
let prisma: PrismaService;
let livekit: LivekitService;
let mediaPresence: MediaPresenceService;
let media: MediaService;
let prefix: string;
let baseUrl: string;
let verifier: TokenVerifier;
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
  participantId: string;
  sessionId: string;
  role: string;
  guestToken: string | null;
  error?: { statusCode: number; message: string | string[] };
}

function nextIp(): string {
  ipCounter += 1;
  return `10.4.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function api(
  method: 'GET' | 'POST',
  url: string,
  options: { headers?: Record<string, string>; payload?: object | string } = {},
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

async function joinWs(socket: Socket, payload: object): Promise<JoinAck> {
  const ack: JoinAck = await socket
    .timeout(EVENT_TIMEOUT_MS)
    .emitWithAck('conference:join', payload);

  if (ack.error) {
    throw Object.assign(new Error('join failed'), { ack });
  }

  return ack;
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

function webhookBody(
  event: string,
  conferenceId: string,
  sessionId: string,
  id: string,
): string {
  return JSON.stringify({
    event,
    id,
    createdAt: '1700000000',
    room: { sid: 'RM_test', name: conferenceId },
    participant: { sid: 'PA_test', identity: sessionId, name: 'Тест' },
  });
}

function postWebhook(body: string, authorization?: string) {
  return app.inject({
    method: 'POST',
    url: `/${prefix}/media/livekit/webhook`,
    remoteAddress: nextIp(),
    headers: {
      'content-type': 'application/webhook+json',
      ...(authorization ? { authorization } : {}),
    },
    payload: body,
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
  await app.listen(0, '127.0.0.1');

  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  prisma = app.get(PrismaService);
  livekit = app.get(LivekitService);
  mediaPresence = app.get(MediaPresenceService);
  media = app.get(MediaService);
  prefix = process.env.API_PREFIX!.replace(/^\/+|\/+$/g, '');
  verifier = new TokenVerifier(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );

  vi.spyOn(livekit, 'deleteRoom').mockResolvedValue(undefined);
  vi.spyOn(livekit, 'removeParticipant').mockResolvedValue(undefined);
  vi.spyOn(livekit, 'listRooms').mockResolvedValue([]);
  vi.spyOn(livekit, 'listParticipants').mockResolvedValue([]);
  vi.spyOn(livekit, 'getRoom').mockResolvedValue(null);
  vi.spyOn(livekit, 'muteMicrophone').mockResolvedValue(undefined);
});

beforeEach(() => {
  vi.mocked(livekit.deleteRoom).mockClear();
  vi.mocked(livekit.removeParticipant).mockClear();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await app?.close();
  vi.restoreAllMocks();

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

describe('медиатокен LiveKit', () => {
  it('выдаёт токен авторизованному участнику и не даёт его без WebSocket', async () => {
    const owner = await createUser('Организатор');
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const joined = await joinWs(socket, { slug: room.slug });

    const response = await api('POST', '/media/token', {
      headers: owner.auth,
      payload: { sessionId: joined.sessionId },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      url: process.env.LIVEKIT_URL,
      conferenceId: joined.conferenceId,
      participantId: joined.participantId,
      sessionId: joined.sessionId,
    });
    expect(body.token).toEqual(expect.any(String));
    expect(body.token).not.toContain(process.env.LIVEKIT_API_SECRET);

    const claims = await verifier.verify(body.token);
    expect(claims.sub).toBe(joined.sessionId);
    expect(claims.name).toBe('Организатор');
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: joined.conferenceId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.roomCreate).toBeUndefined();
    expect(claims.video?.roomRecord).toBeUndefined();
    expect(claims.video?.canPublishSources).toBeUndefined();
    expect(JSON.parse(claims.metadata!)).toMatchObject({
      participantId: joined.participantId,
      userId: owner.id,
      guestId: null,
      role: 'HOST',
    });
    expect(claims.exp! - claims.nbf!).toBeGreaterThanOrEqual(290);
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(310);

    const again = await api('POST', '/media/token', {
      headers: owner.auth,
      payload: { sessionId: joined.sessionId },
    });
    expect(again.statusCode).toBe(200);
    expect(
      await prisma.conferenceParticipantSession.count({
        where: { participantId: joined.participantId },
      }),
    ).toBe(1);

    const rest = await api('POST', `/rooms/by-slug/${room.slug}/join`, {
      headers: owner.auth,
      payload: {},
    });
    expect(rest.statusCode).toBe(200);
    const withoutSocket = await api('POST', '/media/token', {
      headers: owner.auth,
      payload: { sessionId: rest.json().sessionId },
    });
    expect(withoutSocket.statusCode).toBe(403);
  });

  it('выдаёт токен гостю и запрещает чужую сессию', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const room = await createRoom(owner);
    const guestSocket = await connect();
    const joined = await joinWs(guestSocket, {
      slug: room.slug,
      guestName: 'Анна',
    });

    const response = await api('POST', '/media/token', {
      headers: { [GUEST_TOKEN_HEADER]: joined.guestToken! },
      payload: { sessionId: joined.sessionId },
    });

    expect(response.statusCode).toBe(200);
    const claims = await verifier.verify(response.json().token);
    expect(claims.sub).toBe(joined.sessionId);
    expect(claims.name).toBe('Анна');
    expect(JSON.parse(claims.metadata!)).toMatchObject({
      participantId: joined.participantId,
      userId: null,
      role: 'PARTICIPANT',
    });
    expect(JSON.parse(claims.metadata!).guestId).toEqual(expect.any(String));

    const stolenByUser = await api('POST', '/media/token', {
      headers: stranger.auth,
      payload: { sessionId: joined.sessionId },
    });
    expect(stolenByUser.statusCode).toBe(404);

    const ownerSocket = await connect({ token: owner.accessToken });
    const ownerJoin = await joinWs(ownerSocket, { slug: room.slug });
    const stolenByGuest = await api('POST', '/media/token', {
      headers: { [GUEST_TOKEN_HEADER]: joined.guestToken! },
      payload: { sessionId: ownerJoin.sessionId },
    });
    expect(stolenByGuest.statusCode).toBe(404);
  });

  it('запрещает медиатокен завершённой конференции и удаляет медиакомнату', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const joined = await joinWs(socket, { slug: room.slug });

    vi.mocked(livekit.deleteRoom).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED'),
    );
    const failedLivekit = await api(
      'POST',
      `/conferences/${joined.conferenceId}/end`,
      {
        headers: owner.auth,
      },
    );
    expect(failedLivekit.statusCode).toBe(200);
    expect(failedLivekit.json().status).toBe('ENDED');
    expect(livekit.deleteRoom).toHaveBeenCalledWith(joined.conferenceId);
    expect(
      await prisma.conferenceParticipant.count({
        where: { conferenceId: joined.conferenceId },
      }),
    ).toBeGreaterThan(0);

    const denied = await api('POST', '/media/token', {
      headers: owner.auth,
      payload: { sessionId: joined.sessionId },
    });
    expect(denied.statusCode).toBe(403);

    vi.mocked(livekit.listRooms).mockResolvedValueOnce([
      { name: joined.conferenceId } as Room,
    ]);
    await media.reconcile();
    expect(livekit.deleteRoom).toHaveBeenCalledWith(joined.conferenceId);
  });

  it('даёт двум устройствам разные identity и отключает только одно', async () => {
    const owner = await createUser();
    const participant = await createUser('Участник');
    const room = await createRoom(owner);
    const phone = await connect({ token: participant.accessToken });
    const computer = await connect({ token: participant.accessToken });
    const phoneJoin = await joinWs(phone, { slug: room.slug });
    const computerJoin = await joinWs(computer, { slug: room.slug });

    expect(phoneJoin.participantId).toBe(computerJoin.participantId);
    expect(phoneJoin.sessionId).not.toBe(computerJoin.sessionId);

    const phoneToken = await api('POST', '/media/token', {
      headers: participant.auth,
      payload: { sessionId: phoneJoin.sessionId },
    });
    const computerToken = await api('POST', '/media/token', {
      headers: participant.auth,
      payload: { sessionId: computerJoin.sessionId },
    });
    expect(phoneToken.statusCode).toBe(200);
    expect(computerToken.statusCode).toBe(200);

    const phoneClaims = await verifier.verify(phoneToken.json().token);
    const computerClaims = await verifier.verify(computerToken.json().token);
    expect(phoneClaims.sub).toBe(phoneJoin.sessionId);
    expect(computerClaims.sub).toBe(computerJoin.sessionId);
    expect(JSON.parse(phoneClaims.metadata!).participantId).toBe(
      computerJoin.participantId,
    );

    const forbidden = await api(
      'POST',
      `/conferences/${phoneJoin.conferenceId}/sessions/${phoneJoin.sessionId}/disconnect`,
      { headers: participant.auth },
    );
    expect(forbidden.statusCode).toBe(403);

    vi.mocked(livekit.removeParticipant).mockClear();
    const disconnected = await api(
      'POST',
      `/conferences/${phoneJoin.conferenceId}/sessions/${phoneJoin.sessionId}/disconnect`,
      { headers: owner.auth },
    );
    expect(disconnected.statusCode).toBe(200);
    expect(
      (
        await prisma.conferenceParticipantSession.findUniqueOrThrow({
          where: { id: phoneJoin.sessionId },
        })
      ).leftAt,
    ).toEqual(expect.any(Date));
    expect(
      (
        await prisma.conferenceParticipantSession.findUniqueOrThrow({
          where: { id: computerJoin.sessionId },
        })
      ).leftAt,
    ).toBeNull();
    expect(livekit.removeParticipant).toHaveBeenCalledWith(
      phoneJoin.conferenceId,
      phoneJoin.sessionId,
    );
    expect(livekit.removeParticipant).not.toHaveBeenCalledWith(
      phoneJoin.conferenceId,
      computerJoin.sessionId,
    );

    expect(
      (
        await api('POST', '/media/token', {
          headers: participant.auth,
          payload: { sessionId: phoneJoin.sessionId },
        })
      ).statusCode,
    ).toBe(403);
    const stillThere = await api('POST', '/media/token', {
      headers: participant.auth,
      payload: { sessionId: computerJoin.sessionId },
    });
    expect(stillThere.statusCode).toBe(200);

    const muted = await api(
      'POST',
      `/conferences/${computerJoin.conferenceId}/sessions/${computerJoin.sessionId}/microphone/mute`,
      { headers: owner.auth },
    );
    expect(muted.statusCode).toBe(200);
    const mutedToken = await api('POST', '/media/token', {
      headers: participant.auth,
      payload: { sessionId: computerJoin.sessionId },
    });
    const mutedClaims = await verifier.verify(mutedToken.json().token);
    expect(mutedClaims.video?.canPublishSources).toEqual([
      'camera',
      'screen_share',
      'screen_share_audio',
    ]);
    expect(mutedClaims.video?.canPublishSources).not.toContain('microphone');
  });
});

describe('webhook LiveKit', () => {
  it('проверяет подпись, повторно обрабатывает событие и не закрывает WebSocket', async () => {
    const owner = await createUser();
    const room = await createRoom(owner);
    const socket = await connect({ token: owner.accessToken });
    const joined = await joinWs(socket, { slug: room.slug });
    const conferencesBefore = await prisma.conference.count();
    const sessionsBefore = await prisma.conferenceParticipantSession.count({
      where: { participantId: joined.participantId },
    });
    const body = webhookBody(
      'participant_joined',
      joined.conferenceId,
      joined.sessionId,
      'EV_join',
    );

    const unsigned = await postWebhook(body, 'not-a-jwt');
    expect(unsigned.statusCode).toBe(401);
    expect(mediaPresence.isConnected(joined.sessionId)).toBe(false);

    vi.mocked(livekit.removeParticipant).mockClear();
    const signed = await postWebhook(body, await signWebhook(body));
    expect(signed.statusCode).toBe(200);
    expect(signed.json()).toEqual({ received: true });
    expect(mediaPresence.isConnected(joined.sessionId)).toBe(true);
    expect(socket.connected).toBe(true);
    expect(
      (
        await prisma.conferenceParticipantSession.findUniqueOrThrow({
          where: { id: joined.sessionId },
        })
      ).leftAt,
    ).toBeNull();
    expect(await prisma.conference.count()).toBe(conferencesBefore);
    expect(
      await prisma.conferenceParticipantSession.count({
        where: { participantId: joined.participantId },
      }),
    ).toBe(sessionsBefore);
    expect(livekit.removeParticipant).not.toHaveBeenCalled();

    const repeated = await postWebhook(body, await signWebhook(body));
    expect(repeated.statusCode).toBe(200);
    expect(mediaPresence.isConnected(joined.sessionId)).toBe(true);
    expect(livekit.removeParticipant).not.toHaveBeenCalled();

    const otherRoom = randomUUID();
    const foreignBody = webhookBody(
      'participant_joined',
      otherRoom,
      joined.sessionId,
      'EV_foreign',
    );
    const foreign = await postWebhook(
      foreignBody,
      await signWebhook(foreignBody),
    );
    expect(foreign.statusCode).toBe(200);
    expect(livekit.removeParticipant).toHaveBeenCalledWith(
      otherRoom,
      joined.sessionId,
    );
    expect(livekit.removeParticipant).not.toHaveBeenCalledWith(
      joined.conferenceId,
      joined.sessionId,
    );
    expect(
      (
        await prisma.conference.findUniqueOrThrow({
          where: { id: joined.conferenceId },
        })
      ).status,
    ).toBe('ACTIVE');

    const abortedBody = webhookBody(
      'participant_connection_aborted',
      joined.conferenceId,
      joined.sessionId,
      'EV_aborted',
    );
    mediaPresence.markJoined({
      conferenceId: joined.conferenceId,
      participantId: joined.participantId,
      sessionId: joined.sessionId,
      joinedAt: new Date(),
    });
    const aborted = await postWebhook(
      abortedBody,
      await signWebhook(abortedBody),
    );
    expect(aborted.statusCode).toBe(200);
    expect(mediaPresence.isConnected(joined.sessionId)).toBe(false);
    expect(socket.connected).toBe(true);
    expect(
      (
        await prisma.conferenceParticipantSession.findUniqueOrThrow({
          where: { id: joined.sessionId },
        })
      ).leftAt,
    ).toBeNull();

    const leftBody = webhookBody(
      'participant_left',
      joined.conferenceId,
      joined.sessionId,
      'EV_left',
    );
    const left = await postWebhook(leftBody, await signWebhook(leftBody));
    expect(left.statusCode).toBe(200);
    const leftAgain = await postWebhook(leftBody, await signWebhook(leftBody));
    expect(leftAgain.statusCode).toBe(200);
    expect(socket.connected).toBe(true);

    const finishedBody = JSON.stringify({
      event: 'room_finished',
      id: 'EV_room',
      createdAt: '1700000000',
      room: { sid: 'RM_test', name: joined.conferenceId },
    });
    const finished = await postWebhook(
      finishedBody,
      await signWebhook(finishedBody),
    );
    expect(finished.statusCode).toBe(200);
    expect(
      (
        await prisma.conference.findUniqueOrThrow({
          where: { id: joined.conferenceId },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(livekit.deleteRoom).not.toHaveBeenCalled();
  });
});
