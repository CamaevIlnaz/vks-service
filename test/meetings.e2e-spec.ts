import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { RoomStatus, UserStatus } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-meetings.vks.test';
const PASSWORD = 'correct-horse-battery';

let app: NestFastifyApplication;
let prisma: PrismaService;
let prefix: string;
let ipCounter = 0;

interface TestUser {
  id: number;
  name: string;
  email: string;
  auth: { authorization: string };
}

interface MeetingBody {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  room: { id: string; name: string; slug: string };
  organizer: { id: number; name: string; email: string };
  attendees: { id: number; name: string }[];
}

function nextIp(): string {
  ipCounter += 1;
  return `10.26.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
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

function messageOf(response: { json: () => { message?: unknown } }): string {
  const message = response.json().message;

  return Array.isArray(message) ? message.join(' ') : String(message ?? '');
}

async function createUser(name: string): Promise<TestUser> {
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const response = await api('POST', '/auth/register', {
    payload: { email, password: PASSWORD, name },
  });

  expect(response.statusCode, response.body).toBe(201);
  const body = response.json();

  return {
    id: body.user.id,
    name,
    email,
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

async function createRoom(
  owner: TestUser,
  payload: { name?: string; accessType?: 'OPEN' | 'CLOSED' } = {},
) {
  const response = await api('POST', '/rooms', {
    headers: owner.auth,
    payload: { name: 'Комната', ...payload },
  });

  expect(response.statusCode, response.body).toBe(201);

  return response.json() as { id: string; name: string; slug: string };
}

function meetingPayload(
  roomId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    roomId,
    title: 'Планёрка',
    description: 'Обсудим задачи',
    startsAt: '2027-03-01T10:00:00Z',
    endsAt: '2027-03-01T11:00:00Z',
    attendeeIds: [] as number[],
    ...overrides,
  };
}

async function createMeeting(
  user: TestUser,
  roomId: string,
  overrides: Record<string, unknown> = {},
) {
  const response = await api('POST', '/meetings', {
    headers: user.auth,
    payload: meetingPayload(roomId, overrides),
  });

  expect(response.statusCode, response.body).toBe(201);

  return response.json() as MeetingBody;
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
  try {
    await prisma.meeting.deleteMany({
      where: { organizer: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
    });
    await prisma.room.deleteMany({
      where: { owner: { email: { endsWith: `@${EMAIL_DOMAIN}` } } },
    });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
    });
  } finally {
    await app.close();
  }
});

describe('встречи', () => {
  it('требует access token', async () => {
    expect((await api('GET', '/meetings')).statusCode).toBe(401);
    expect(
      (
        await api('POST', '/meetings', {
          payload: meetingPayload(randomUUID()),
        })
      ).statusCode,
    ).toBe(401);
  });

  it('создаёт встречу от имени владельца комнаты и хранит время в UTC', async () => {
    const owner = await createUser('Организатор');
    const anna = await createUser('Анна');
    const boris = await createUser('Борис');
    const room = await createRoom(owner, { name: 'Команда' });
    const created = await createMeeting(owner, room.id, {
      title: '  Планёрка  ',
      description: '  Итоги  ',
      startsAt: '2027-03-01T15:00:00+05:00',
      endsAt: '2027-03-01T16:30:00+05:00',
      attendeeIds: [boris.id, anna.id],
    });

    expect(created).toMatchObject({
      title: 'Планёрка',
      description: 'Итоги',
      startsAt: '2027-03-01T10:00:00.000Z',
      endsAt: '2027-03-01T11:30:00.000Z',
      room: { id: room.id, name: 'Команда', slug: room.slug },
      organizer: { id: owner.id, name: 'Организатор', email: owner.email },
    });
    expect(created.attendees.map((attendee) => attendee.name)).toEqual([
      'Анна',
      'Борис',
    ]);
    expect(await prisma.roomMember.count({ where: { roomId: room.id } })).toBe(
      0,
    );

    const loaded = await api('GET', `/meetings/${created.id}`, {
      headers: owner.auth,
    });

    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ id: created.id, title: 'Планёрка' });
  });

  it('отклоняет некорректные поля и не даёт назначить организатора', async () => {
    const owner = await createUser('Организатор');
    const guest = await createUser('Гость');
    const room = await createRoom(owner);
    const base = meetingPayload(room.id);

    const cases: { payload: object; status: number; text: string }[] = [
      {
        payload: { ...base, title: '   ' },
        status: 400,
        text: 'Название встречи обязательно',
      },
      {
        payload: { ...base, endsAt: '2027-03-01T10:00:00Z' },
        status: 400,
        text: 'endsAt должен быть позже startsAt',
      },
      {
        payload: { ...base, startsAt: '2027-03-01T10:00:00' },
        status: 400,
        text: 'часовым поясом',
      },
      {
        payload: { ...base, attendeeIds: [guest.id, guest.id] },
        status: 400,
        text: 'повторяющиеся',
      },
      {
        payload: { ...base, attendeeIds: [owner.id] },
        status: 400,
        text: 'Организатор уже участвует',
      },
      {
        payload: { ...base, organizerId: guest.id },
        status: 400,
        text: 'organizerId',
      },
      {
        payload: { ...base, attendeeIds: [999_999_999] },
        status: 404,
        text: 'не найден',
      },
      {
        payload: meetingPayload(randomUUID()),
        status: 404,
        text: 'Комната не найдена',
      },
    ];

    for (const item of cases) {
      const response = await api('POST', '/meetings', {
        headers: owner.auth,
        payload: item.payload,
      });

      expect(response.statusCode, response.body).toBe(item.status);
      expect(messageOf(response)).toContain(item.text);
    }

    await prisma.user.update({
      where: { id: guest.id },
      data: { status: UserStatus.BLOCKED },
    });
    const blocked = await api('POST', '/meetings', {
      headers: owner.auth,
      payload: meetingPayload(room.id, { attendeeIds: [guest.id] }),
    });

    expect(blocked.statusCode, blocked.body).toBe(400);
    expect(messageOf(blocked)).toContain('активн');
  });

  it('приглашает в открытую комнату любого пользователя, а в закрытую — только участников', async () => {
    const owner = await createUser('Владелец');
    const member = await createUser('Участник');
    const outsider = await createUser('Посторонний');
    const openRoom = await createRoom(owner, { name: 'Открытая' });
    const closedRoom = await createRoom(owner, {
      name: 'Закрытая',
      accessType: 'CLOSED',
    });
    const added = await api('POST', `/rooms/${closedRoom.id}/members`, {
      headers: owner.auth,
      payload: { userId: member.id },
    });

    expect(added.statusCode, added.body).toBe(201);

    const openMeeting = await createMeeting(owner, openRoom.id, {
      attendeeIds: [outsider.id],
    });

    expect(openMeeting.attendees.map((attendee) => attendee.id)).toEqual([
      outsider.id,
    ]);
    expect(
      await prisma.roomMember.count({
        where: { roomId: openRoom.id, userId: outsider.id },
      }),
    ).toBe(0);

    const closedMeeting = await createMeeting(owner, closedRoom.id, {
      attendeeIds: [member.id],
    });

    expect(closedMeeting.attendees.map((attendee) => attendee.id)).toEqual([
      member.id,
    ]);

    const denied = await api('POST', '/meetings', {
      headers: owner.auth,
      payload: meetingPayload(closedRoom.id, { attendeeIds: [outsider.id] }),
    });

    expect(denied.statusCode, denied.body).toBe(400);
    expect(messageOf(denied)).toContain('закрытую комнату');

    const byMember = await api('POST', '/meetings', {
      headers: member.auth,
      payload: meetingPayload(closedRoom.id, { attendeeIds: [owner.id] }),
    });
    const byOutsider = await api('POST', '/meetings', {
      headers: outsider.auth,
      payload: meetingPayload(openRoom.id),
    });

    expect(byMember.statusCode, byMember.body).toBe(404);
    expect(byOutsider.statusCode, byOutsider.body).toBe(404);
  });

  it('не создаёт встречу в завершённой или удалённой комнате', async () => {
    const owner = await createUser('Владелец');
    const ended = await createRoom(owner, { name: 'Завершённая' });
    const removed = await createRoom(owner, { name: 'Удалённая' });
    const kept = await createMeeting(owner, ended.id, { title: 'Прошедшая' });

    await prisma.room.update({
      where: { id: ended.id },
      data: { status: RoomStatus.ENDED },
    });
    await prisma.room.update({
      where: { id: removed.id },
      data: { deletedAt: new Date() },
    });

    const endedResponse = await api('POST', '/meetings', {
      headers: owner.auth,
      payload: meetingPayload(ended.id),
    });
    const removedResponse = await api('POST', '/meetings', {
      headers: owner.auth,
      payload: meetingPayload(removed.id),
    });
    const stillVisible = await api('GET', `/meetings/${kept.id}`, {
      headers: owner.auth,
    });

    expect(endedResponse.statusCode, endedResponse.body).toBe(410);
    expect(removedResponse.statusCode, removedResponse.body).toBe(404);
    expect(stillVisible.statusCode).toBe(200);

    await prisma.room.update({
      where: { id: ended.id },
      data: { deletedAt: new Date() },
    });
    const hidden = await api('GET', '/meetings', { headers: owner.auth });

    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().items).toEqual([]);
    expect(
      (await api('GET', `/meetings/${kept.id}`, { headers: owner.auth }))
        .statusCode,
    ).toBe(404);
  });

  it('показывает встречу организатору и приглашённому, фильтрует период и пагинирует', async () => {
    const owner = await createUser('Организатор');
    const guest = await createUser('Гость');
    const stranger = await createUser('Зритель');
    const room = await createRoom(owner, { name: 'Календарь' });
    const later = await createMeeting(owner, room.id, {
      title: 'Послезавтра',
      startsAt: '2027-03-02T10:00:00Z',
      endsAt: '2027-03-02T11:00:00Z',
    });
    const first = await createMeeting(owner, room.id, {
      title: 'Утро',
      startsAt: '2027-03-01T10:00:00Z',
      endsAt: '2027-03-01T11:00:00Z',
      attendeeIds: [guest.id],
    });
    const second = await createMeeting(owner, room.id, {
      title: 'День',
      startsAt: '2027-03-01T11:00:00Z',
      endsAt: '2027-03-01T12:00:00Z',
    });

    const list = await api('GET', '/meetings', { headers: owner.auth });
    const overlap = await api(
      'GET',
      '/meetings?from=2027-03-01T10:30:00Z&to=2027-03-01T11:30:00Z',
      { headers: owner.auth },
    );
    const touching = await api(
      'GET',
      '/meetings?from=2027-03-01T11:00:00Z&to=2027-03-01T12:00:00Z',
      { headers: owner.auth },
    );
    const page = await api('GET', '/meetings?page=2&limit=1', {
      headers: owner.auth,
    });
    const guestList = await api('GET', '/meetings', { headers: guest.auth });
    const guestMeeting = await api('GET', `/meetings/${first.id}`, {
      headers: guest.auth,
    });
    const strangerList = await api('GET', '/meetings', {
      headers: stranger.auth,
    });
    const strangerMeeting = await api('GET', `/meetings/${first.id}`, {
      headers: stranger.auth,
    });
    const badPeriod = await api(
      'GET',
      '/meetings?from=2027-03-02T00:00:00Z&to=2027-03-01T00:00:00Z',
      { headers: owner.auth },
    );

    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((item: MeetingBody) => item.title)).toEqual([
      'Утро',
      'День',
      'Послезавтра',
    ]);
    expect(list.json()).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect(overlap.json().items.map((item: MeetingBody) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(touching.json().items.map((item: MeetingBody) => item.id)).toEqual([
      second.id,
    ]);
    expect(page.json()).toMatchObject({
      total: 3,
      page: 2,
      limit: 1,
      items: [{ id: second.id }],
    });
    expect(guestList.json().items.map((item: MeetingBody) => item.id)).toEqual([
      first.id,
    ]);
    expect(guestMeeting.statusCode).toBe(200);
    expect(guestMeeting.json().room).toEqual({
      id: room.id,
      name: 'Календарь',
      slug: room.slug,
    });
    expect(guestMeeting.json().organizer.name).toBe('Организатор');
    expect(strangerList.json().items).toEqual([]);
    expect(strangerMeeting.statusCode).toBe(404);
    expect(badPeriod.statusCode).toBe(400);
    expect(later.id).toBeTruthy();
  });

  it('изменяет встречу только организатором и заново проверяет комнату и приглашённых', async () => {
    const owner = await createUser('Организатор');
    const guest = await createUser('Гость');
    const member = await createUser('Участник');
    const other = await createUser('Чужая');
    const openRoom = await createRoom(owner, { name: 'Открытая' });
    const otherOpen = await createRoom(owner, { name: 'Вторая' });
    const closedRoom = await createRoom(owner, {
      name: 'Закрытая',
      accessType: 'CLOSED',
    });
    const foreignRoom = await createRoom(other, { name: 'Чужая' });

    expect(
      (
        await api('POST', `/rooms/${closedRoom.id}/members`, {
          headers: owner.auth,
          payload: { userId: member.id },
        })
      ).statusCode,
    ).toBe(201);

    const meeting = await createMeeting(owner, openRoom.id, {
      attendeeIds: [guest.id],
    });
    const emptyPatch = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: {},
    });
    const byGuest = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: guest.auth,
      payload: { title: 'Чужое' },
    });
    const tooEarly = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: { endsAt: '2027-03-01T09:00:00Z' },
    });
    const moveToClosed = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: { roomId: closedRoom.id },
    });
    const moveToForeign = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: { roomId: foreignRoom.id },
    });
    const unchanged = await api('GET', `/meetings/${meeting.id}`, {
      headers: owner.auth,
    });

    expect(emptyPatch.statusCode, emptyPatch.body).toBe(400);
    expect(byGuest.statusCode, byGuest.body).toBe(403);
    expect(tooEarly.statusCode, tooEarly.body).toBe(400);
    expect(messageOf(tooEarly)).toContain('endsAt должен быть позже startsAt');
    expect(moveToClosed.statusCode, moveToClosed.body).toBe(400);
    expect(moveToForeign.statusCode, moveToForeign.body).toBe(404);
    expect(unchanged.json()).toMatchObject({
      title: 'Планёрка',
      room: { id: openRoom.id },
      endsAt: '2027-03-01T11:00:00.000Z',
    });

    const moved = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: {
        roomId: otherOpen.id,
        title: 'Перенос',
        description: null,
        attendeeIds: [],
        startsAt: '2027-03-03T08:00:00Z',
        endsAt: '2027-03-03T09:00:00Z',
      },
    });
    const withMember = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: owner.auth,
      payload: { roomId: closedRoom.id, attendeeIds: [member.id] },
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      title: 'Перенос',
      description: null,
      startsAt: '2027-03-03T08:00:00.000Z',
      endsAt: '2027-03-03T09:00:00.000Z',
      room: { id: otherOpen.id, name: 'Вторая' },
      attendees: [],
    });
    expect(withMember.statusCode, withMember.body).toBe(200);
    expect(withMember.json().room.id).toBe(closedRoom.id);
    expect(
      withMember.json().attendees.map((item: { id: number }) => item.id),
    ).toEqual([member.id]);
  });

  it('удаляет встречу только организатором', async () => {
    const owner = await createUser('Организатор');
    const guest = await createUser('Гость');
    const room = await createRoom(owner);
    const meeting = await createMeeting(owner, room.id, {
      attendeeIds: [guest.id],
    });
    const byGuest = await api('DELETE', `/meetings/${meeting.id}`, {
      headers: guest.auth,
    });

    expect(byGuest.statusCode, byGuest.body).toBe(403);
    expect(
      (await api('GET', `/meetings/${meeting.id}`, { headers: guest.auth }))
        .statusCode,
    ).toBe(200);

    const removed = await api('DELETE', `/meetings/${meeting.id}`, {
      headers: owner.auth,
    });

    expect(removed.statusCode, removed.body).toBe(204);
    expect(removed.body).toBe('');
    expect(
      (await api('GET', `/meetings/${meeting.id}`, { headers: owner.auth }))
        .statusCode,
    ).toBe(404);
    expect(
      await prisma.meetingAttendee.count({ where: { meetingId: meeting.id } }),
    ).toBe(0);
  });

  it('закрывает доступ к встречам закрытой комнаты после удаления участника', async () => {
    const owner = await createUser('Владелец');
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

    const meeting = await createMeeting(owner, room.id, {
      attendeeIds: [member.id],
    });

    expect(
      (await api('GET', `/meetings/${meeting.id}`, { headers: member.auth }))
        .statusCode,
    ).toBe(200);

    const removal = await api(
      'DELETE',
      `/rooms/${room.id}/members/${member.id}`,
      { headers: owner.auth },
    );
    const memberMeeting = await api('GET', `/meetings/${meeting.id}`, {
      headers: member.auth,
    });
    const memberList = await api('GET', '/meetings', { headers: member.auth });
    const memberPatch = await api('PATCH', `/meetings/${meeting.id}`, {
      headers: member.auth,
      payload: { title: 'Нельзя' },
    });
    const ownerMeeting = await api('GET', `/meetings/${meeting.id}`, {
      headers: owner.auth,
    });

    expect(removal.statusCode, removal.body).toBe(204);
    expect(memberMeeting.statusCode).toBe(404);
    expect(memberList.json().items).toEqual([]);
    expect(memberPatch.statusCode).toBe(404);
    expect(ownerMeeting.statusCode).toBe(200);
    expect(
      ownerMeeting.json().attendees.map((item: { id: number }) => item.id),
    ).toEqual([member.id]);
  });
});
