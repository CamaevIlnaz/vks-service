import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { ConferenceParticipantRole } from '../src/generated/prisma/client.js';
import { GUEST_TOKEN_HEADER } from '../src/modules/conferences/guest-tokens.service.js';
import { ConferencesScheduler } from '../src/modules/conferences/conferences.scheduler.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const EMAIL_DOMAIN = 'e2e-docs.vks.test';
const PASSWORD = 'correct-horse-battery';

let app: NestFastifyApplication;
let prisma: PrismaService;
let scheduler: ConferencesScheduler;
let prefix: string;
let ipCounter = 0;
const editors: HocuspocusProvider[] = [];

function nextIp(): string {
  ipCounter += 1;
  return `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

interface TestUser {
  id: number;
  email: string;
  auth: { authorization: string };
}

interface Editor {
  doc: Y.Doc;
  provider: HocuspocusProvider;
}

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

async function createRoom(owner: TestUser) {
  const response = await api('POST', '/rooms', {
    headers: owner.auth,
    payload: { name: 'Комната документов' },
  });

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

function text(doc: Y.Doc): string {
  return doc.getText('content').toString();
}

function storedText(state: Uint8Array): string {
  const doc = new Y.Doc();

  Y.applyUpdate(doc, state);
  const value = doc.getText('content').toString();

  doc.destroy();

  return value;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeout = 8_000,
): Promise<void> {
  const started = Date.now();

  while (!(await predicate())) {
    if (Date.now() - started > timeout) {
      throw new Error('Условие не выполнилось');
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function connect(
  url: string,
  documentId: string,
  token: string,
): Promise<Editor> {
  const doc = new Y.Doc();
  let provider: HocuspocusProvider;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      provider?.destroy();
      reject(new Error('Документ не синхронизировался'));
    }, 8_000);

    provider = new HocuspocusProvider({
      url,
      name: `document:${documentId}`,
      token,
      document: doc,
      onSynced() {
        clearTimeout(timeout);
        editors.push(provider);
        resolve({ doc, provider });
      },
      onAuthenticationFailed({ reason }) {
        clearTimeout(timeout);
        provider.destroy();
        reject(new Error(reason || 'Доступ запрещён'));
      },
    });
  });
}

function closeEditors(): void {
  for (const provider of editors) {
    provider.destroy();
  }

  editors.length = 0;
}

beforeAll(async () => {
  process.env.COLLABORATION_PORT = '41234';
  process.env.COLLABORATION_URL = 'ws://127.0.0.1:41234';
  process.env.COLLABORATION_DEBOUNCE_MS = '3000';
  process.env.COLLABORATION_MAX_DEBOUNCE_MS = '10000';

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

afterEach(() => {
  closeEditors();
});

afterAll(async () => {
  closeEditors();

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
    await prisma.room.deleteMany({ where: roomFilter.room });
    await prisma.user.deleteMany({
      where: { email: { endsWith: `@${EMAIL_DOMAIN}` } },
    });
  }

  await app?.close();
});

describe('документы комнаты', () => {
  it('создаёт, ищет, сортирует и логически удаляет документы владельца', async () => {
    const owner = await createUser('Владелец');
    const stranger = await createUser('Чужой');
    const room = await createRoom(owner);

    const created = await api('POST', `/rooms/${room.id}/documents`, {
      headers: owner.auth,
      payload: { title: '  Протокол  ', roomId: room.id },
    });

    expect(created.statusCode).toBe(400);

    const protocol = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title: '  Протокол  ' },
      })
    ).json();
    const notes = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title: 'Заметки' },
      })
    ).json();

    expect(protocol).toMatchObject({
      roomId: room.id,
      title: 'Протокол',
      createdById: owner.id,
    });
    expect(protocol.yjsState).toBeUndefined();

    const forbidden = await api('GET', `/rooms/${room.id}/documents`, {
      headers: stranger.auth,
    });

    expect(forbidden.statusCode).toBe(404);

    const found = await api(
      'GET',
      `/rooms/${room.id}/documents?search=прот&sortBy=title&sortOrder=asc&limit=1`,
      { headers: owner.auth },
    );

    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      total: 1,
      page: 1,
      limit: 1,
      items: [{ id: protocol.id, title: 'Протокол' }],
    });

    const renamed = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${protocol.id}`,
      { headers: owner.auth, payload: { title: 'Итоговый протокол' } },
    );

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe('Итоговый протокол');

    const strangerRename = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${notes.id}`,
      { headers: stranger.auth, payload: { title: 'Чужое' } },
    );

    expect(strangerRename.statusCode).toBe(404);

    const removed = await api(
      'DELETE',
      `/rooms/${room.id}/documents/${notes.id}`,
      { headers: owner.auth },
    );

    expect(removed.statusCode).toBe(204);

    const list = await api('GET', `/rooms/${room.id}/documents`, {
      headers: owner.auth,
    });

    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([
      protocol.id,
    ]);
    expect(
      (
        await api('GET', `/rooms/${room.id}/documents/${notes.id}`, {
          headers: owner.auth,
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('совместное редактирование', () => {
  async function openMeeting(owner: TestUser, title = 'Повестка') {
    const room = await createRoom(owner);
    const document = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title },
      })
    ).json();
    const ownerJoin = (await join(room.slug, { headers: owner.auth })).json();
    const attached = await api(
      'POST',
      `/conferences/${ownerJoin.conferenceId}/documents`,
      { headers: owner.auth, payload: { documentId: document.id } },
    );

    expect(attached.statusCode).toBe(201);

    return {
      room,
      document,
      conferenceId: ownerJoin.conferenceId as string,
      sessionId: ownerJoin.sessionId as string,
    };
  }

  async function editorToken(
    user: TestUser | { guestToken: string },
    roomId: string,
    documentId: string,
  ) {
    const headers =
      'auth' in user ? user.auth : { [GUEST_TOKEN_HEADER]: user.guestToken };
    const response = await api(
      'POST',
      `/rooms/${roomId}/documents/${documentId}/access`,
      { headers },
    );

    return response;
  }

  it('позволяет переименовать документ любому, кто сейчас на встрече', async () => {
    const owner = await createUser('Владелец');
    const colleague = await createUser('Участник');
    const outsider = await createUser('Мимо');
    const { room, document } = await openMeeting(owner);
    const colleagueJoin = (
      await join(room.slug, { headers: colleague.auth })
    ).json();
    const draft = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title: 'Черновик' },
      })
    ).json();

    const byColleague = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${document.id}`,
      { headers: colleague.auth, payload: { title: 'От участника' } },
    );

    expect(byColleague.statusCode).toBe(200);
    expect(byColleague.json().title).toBe('От участника');

    const unattached = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${draft.id}`,
      { headers: colleague.auth, payload: { title: 'Тоже от участника' } },
    );

    expect(unattached.statusCode).toBe(200);

    const guestJoin = (
      await join(room.slug, { payload: { guestName: 'Гость' } })
    ).json();
    const byGuest = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${document.id}`,
      {
        headers: { [GUEST_TOKEN_HEADER]: guestJoin.guestToken as string },
        payload: { title: 'От гостя' },
      },
    );

    expect(byGuest.statusCode).toBe(200);
    expect(byGuest.json().title).toBe('От гостя');

    const hidden = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${document.id}`,
      { headers: outsider.auth, payload: { title: 'Чужое' } },
    );

    expect(hidden.statusCode).toBe(404);

    const leave = await api(
      'POST',
      `/conferences/sessions/${colleagueJoin.sessionId}/leave`,
      { headers: colleague.auth },
    );

    expect(leave.statusCode).toBe(200);

    const afterLeave = await api(
      'PATCH',
      `/rooms/${room.id}/documents/${document.id}`,
      { headers: colleague.auth, payload: { title: 'После выхода' } },
    );

    expect(afterLeave.statusCode).toBe(403);
  });

  it('синхронизирует одновременные правки, восстанавливает их после переподключения и не считает курсор правкой', async () => {
    const owner = await createUser('Редактор');
    const colleague = await createUser('Коллега');
    const { room, document, conferenceId } = await openMeeting(owner);

    const colleagueJoin = (
      await join(room.slug, { headers: colleague.auth })
    ).json();
    const ownerAccess = await editorToken(owner, room.id, document.id);
    const colleagueAccess = await editorToken(colleague, room.id, document.id);

    expect(ownerAccess.statusCode).toBe(200);
    expect(ownerAccess.json()).toMatchObject({
      documentName: `document:${document.id}`,
      url: 'ws://127.0.0.1:41234',
    });

    const ownerEditor = await connect(
      ownerAccess.json().url,
      document.id,
      ownerAccess.json().token,
    );

    ownerEditor.provider.setAwarenessField('user', {
      name: 'Редактор',
      cursor: { anchor: 0, head: 0 },
    });
    ownerEditor.provider.destroy();
    editors.splice(editors.indexOf(ownerEditor.provider), 1);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const beforeEdit = await prisma.conferenceDocument.findFirstOrThrow({
      where: { conferenceId, documentId: document.id },
    });

    expect(beforeEdit.firstEditedAt).toBeNull();
    expect(beforeEdit.lastEditedAt).toBeNull();

    const freshOwnerAccess = await editorToken(owner, room.id, document.id);
    const left = await connect(
      freshOwnerAccess.json().url,
      document.id,
      freshOwnerAccess.json().token,
    );
    const right = await connect(
      colleagueAccess.json().url,
      document.id,
      colleagueAccess.json().token,
    );

    left.doc.getText('content').insert(0, 'A');
    right.doc.getText('content').insert(0, 'B');

    await waitFor(
      () =>
        text(left.doc).includes('A') &&
        text(left.doc).includes('B') &&
        text(left.doc) === text(right.doc),
    );

    left.provider.destroy();
    right.provider.destroy();
    editors.length = 0;

    await waitFor(async () => {
      const row = await prisma.roomDocument.findUniqueOrThrow({
        where: { id: document.id },
      });

      return storedText(row.yjsState) === text(left.doc);
    });

    const restoredAccess = await editorToken(owner, room.id, document.id);
    const restored = await connect(
      restoredAccess.json().url,
      document.id,
      restoredAccess.json().token,
    );

    expect(text(restored.doc)).toBe(text(left.doc));
    expect(colleagueJoin.participantId).toEqual(expect.any(String));
  });

  it('сохраняет правку при завершении конференции, не дублирует связь и продолжает документ на следующей встрече', async () => {
    const owner = await createUser('Организатор');
    const participant = await createUser('Участник');
    const { room, document, conferenceId } = await openMeeting(
      owner,
      'Живой документ',
    );
    const participantJoin = (
      await join(room.slug, { headers: participant.auth })
    ).json();
    const duplicate = await api(
      'POST',
      `/conferences/${conferenceId}/documents`,
      { headers: owner.auth, payload: { documentId: document.id } },
    );

    expect(duplicate.statusCode).toBe(409);
    expect(
      await prisma.conferenceDocument.count({ where: { conferenceId } }),
    ).toBe(1);

    const participantAttach = await api(
      'POST',
      `/conferences/${conferenceId}/documents`,
      {
        headers: participant.auth,
        payload: { documentId: document.id },
      },
    );

    expect(participantAttach.statusCode).toBe(403);

    await prisma.conferenceParticipant.update({
      where: { id: participantJoin.participantId },
      data: { role: ConferenceParticipantRole.MODERATOR },
    });

    const second = (
      await api('POST', `/rooms/${room.id}/documents`, {
        headers: owner.auth,
        payload: { title: 'Не трогали' },
      })
    ).json();
    const moderatorAttach = await api(
      'POST',
      `/conferences/${conferenceId}/documents`,
      {
        headers: participant.auth,
        payload: { documentId: second.id },
      },
    );

    expect(moderatorAttach.statusCode).toBe(201);

    const otherRoom = await createRoom(owner);
    const foreign = (
      await api('POST', `/rooms/${otherRoom.id}/documents`, {
        headers: owner.auth,
        payload: { title: 'Чужая комната' },
      })
    ).json();
    const foreignAttach = await api(
      'POST',
      `/conferences/${conferenceId}/documents`,
      { headers: owner.auth, payload: { documentId: foreign.id } },
    );

    expect(foreignAttach.statusCode).toBe(404);

    const ownerAccess = await editorToken(owner, room.id, document.id);
    const peerAccess = await editorToken(participant, room.id, document.id);
    const author = await connect(
      ownerAccess.json().url,
      document.id,
      ownerAccess.json().token,
    );
    const peer = await connect(
      peerAccess.json().url,
      document.id,
      peerAccess.json().token,
    );

    author.doc.getText('content').insert(0, 'Версия встречи');
    await waitFor(() => text(peer.doc) === 'Версия встречи');

    const ended = await api('POST', `/conferences/${conferenceId}/end`, {
      headers: owner.auth,
    });

    expect(ended.statusCode).toBe(200);
    expect(ended.json().status).toBe('ENDED');

    const row = await prisma.roomDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    const link = await prisma.conferenceDocument.findFirstOrThrow({
      where: { conferenceId, documentId: document.id },
    });

    expect(storedText(row.yjsState)).toBe('Версия встречи');
    expect(link.firstEditedAt).toEqual(expect.any(Date));
    expect(link.lastEditedAt).toEqual(link.firstEditedAt);

    const history = await api(
      'GET',
      `/conferences/${conferenceId}/documents?editedOnly=true`,
      { headers: participant.auth },
    );

    expect(history.statusCode).toBe(200);
    expect(history.json().items).toEqual([
      expect.objectContaining({
        documentId: document.id,
        title: 'Живой документ',
        lastEditedAt: expect.any(String),
      }),
    ]);

    const untouched = await api(
      'GET',
      `/conferences/${conferenceId}/documents`,
      { headers: participant.auth },
    );

    expect(untouched.json().total).toBe(2);

    const afterEnd = await editorToken(participant, room.id, document.id);

    expect(afterEnd.statusCode).toBe(403);

    const detach = await api(
      'DELETE',
      `/conferences/${conferenceId}/documents/${document.id}`,
      { headers: owner.auth },
    );

    expect(detach.statusCode).toBe(409);

    const ownerAgain = (await join(room.slug, { headers: owner.auth })).json();
    const nextConferenceId = ownerAgain.conferenceId as string;

    expect(nextConferenceId).not.toBe(conferenceId);

    const reattached = await api(
      'POST',
      `/conferences/${nextConferenceId}/documents`,
      { headers: owner.auth, payload: { documentId: document.id } },
    );

    expect(reattached.statusCode).toBe(201);
    expect(reattached.json().documentId).toBe(document.id);
    expect(reattached.json().firstEditedAt).toBeNull();

    const participantAgain = await join(room.slug, {
      headers: participant.auth,
    });

    expect(participantAgain.statusCode).toBe(200);

    const nextAccess = await editorToken(participant, room.id, document.id);
    const next = await connect(
      nextAccess.json().url,
      document.id,
      nextAccess.json().token,
    );

    expect(text(next.doc)).toBe('Версия встречи');
    next.doc.getText('content').insert(text(next.doc).length, ' и дальше');
    await waitFor(
      () =>
        text(next.doc) === 'Версия встречи и дальше' &&
        !next.provider.hasUnsyncedChanges,
    );

    const secondEnd = await api(
      'POST',
      `/conferences/${nextConferenceId}/end`,
      { headers: owner.auth },
    );

    expect(secondEnd.statusCode).toBe(200);

    const links = await prisma.conferenceDocument.findMany({
      where: { documentId: document.id },
      orderBy: { attachedAt: 'asc' },
    });
    const updated = await prisma.roomDocument.findUniqueOrThrow({
      where: { id: document.id },
    });

    expect(links).toHaveLength(2);
    expect(links[0]?.firstEditedAt).toEqual(link.firstEditedAt);
    expect(links[1]?.firstEditedAt).toEqual(expect.any(Date));
    expect(links[1]?.firstEditedAt).not.toEqual(links[0]?.firstEditedAt);
    expect(storedText(updated.yjsState)).toBe('Версия встречи и дальше');
    expect(
      await prisma.roomDocument.count({
        where: { roomId: room.id, deletedAt: null },
      }),
    ).toBe(2);
  });

  it('обновляет lastEditedAt и оставляет firstEditedAt при повторной правке', async () => {
    const owner = await createUser('Автор');
    const { room, document, conferenceId } = await openMeeting(owner);
    const access = await editorToken(owner, room.id, document.id);
    const editor = await connect(
      access.json().url,
      document.id,
      access.json().token,
    );

    editor.doc.getText('content').insert(0, 'раз');
    await waitFor(async () => {
      const link = await prisma.conferenceDocument.findFirstOrThrow({
        where: { conferenceId, documentId: document.id },
      });

      return link.firstEditedAt !== null;
    }, 12_000);

    const first = await prisma.conferenceDocument.findFirstOrThrow({
      where: { conferenceId, documentId: document.id },
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    editor.doc.getText('content').insert(text(editor.doc).length, ' два');

    await waitFor(async () => {
      const link = await prisma.conferenceDocument.findFirstOrThrow({
        where: { conferenceId, documentId: document.id },
      });

      return (
        link.lastEditedAt !== null &&
        first.lastEditedAt !== null &&
        link.lastEditedAt > first.lastEditedAt
      );
    }, 12_000);

    const second = await prisma.conferenceDocument.findFirstOrThrow({
      where: { conferenceId, documentId: document.id },
    });

    expect(second.firstEditedAt).toEqual(first.firstEditedAt);
  });

  it('пускает гостя только в активную конференцию и отзывает доступ удалённого участника', async () => {
    const owner = await createUser('Хост');
    const guestUser = await createUser('Будет удалён');
    const { room, document, conferenceId } = await openMeeting(owner);
    const guestJoin = (
      await join(room.slug, { payload: { guestName: 'Гость Анна' } })
    ).json();
    const guestHeaders = {
      [GUEST_TOKEN_HEADER]: guestJoin.guestToken as string,
    };
    const removedJoin = (
      await join(room.slug, { headers: guestUser.auth })
    ).json();

    const guestList = await api(
      'GET',
      `/conferences/${conferenceId}/documents`,
      { headers: guestHeaders },
    );

    expect(guestList.statusCode).toBe(200);
    expect(guestList.json().items[0].title).toBe('Повестка');

    const guestAccess = await editorToken(
      { guestToken: guestJoin.guestToken },
      room.id,
      document.id,
    );

    expect(guestAccess.statusCode).toBe(200);

    const guestEditor = await connect(
      guestAccess.json().url,
      document.id,
      guestAccess.json().token,
    );
    const ownerAccess = await editorToken(owner, room.id, document.id);
    const ownerEditor = await connect(
      ownerAccess.json().url,
      document.id,
      ownerAccess.json().token,
    );

    guestEditor.doc.getText('content').insert(0, 'от гостя');
    await waitFor(() => text(ownerEditor.doc) === 'от гостя');

    const removedAccess = await editorToken(guestUser, room.id, document.id);
    const removedEditor = await connect(
      removedAccess.json().url,
      document.id,
      removedAccess.json().token,
    );
    const closed = new Promise<void>((resolve) => {
      removedEditor.provider.on('close', () => resolve());
    });

    const removal = await api(
      'POST',
      `/conferences/${conferenceId}/participants/${removedJoin.participantId}/remove`,
      { headers: owner.auth },
    );

    expect(removal.statusCode).toBe(200);
    await closed;

    const denied = await editorToken(guestUser, room.id, document.id);

    expect(denied.statusCode).toBe(403);
    await expect(
      connect(
        removedAccess.json().url,
        document.id,
        removedAccess.json().token,
      ),
    ).rejects.toThrow();

    removedEditor.doc.getText('content').insert(0, 'тайком');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(text(ownerEditor.doc)).toBe('от гостя');

    await api('POST', `/conferences/${conferenceId}/end`, {
      headers: owner.auth,
    });

    const guestAfter = await api(
      'GET',
      `/conferences/${conferenceId}/documents`,
      { headers: guestHeaders },
    );
    const guestTokenAfter = await editorToken(
      { guestToken: guestJoin.guestToken },
      room.id,
      document.id,
    );

    expect(guestAfter.statusCode).toBe(403);
    expect(guestTokenAfter.statusCode).toBe(403);

    const stranger = await createUser('Зритель');
    const hidden = await api('GET', `/conferences/${conferenceId}/documents`, {
      headers: stranger.auth,
    });

    expect(hidden.statusCode).toBe(404);
  });

  it('не теряет текст, когда пустая конференция завершается автоматически', async () => {
    const owner = await createUser('Авто');
    const { room, document, conferenceId, sessionId } =
      await openMeeting(owner);
    const access = await editorToken(owner, room.id, document.id);
    const editor = await connect(
      access.json().url,
      document.id,
      access.json().token,
    );

    editor.doc.getText('content').insert(0, 'до автозавершения');
    await waitFor(() => !editor.provider.hasUnsyncedChanges);

    const leave = await api(
      'POST',
      `/conferences/sessions/${sessionId}/leave`,
      { headers: owner.auth },
    );

    expect(leave.statusCode).toBe(200);

    await prisma.conference.update({
      where: { id: conferenceId },
      data: { emptyAt: new Date(Date.now() - 10 * 60_000) },
    });

    const finished = await scheduler.finishEmptyConferences();
    const row = await prisma.roomDocument.findUniqueOrThrow({
      where: { id: document.id },
    });
    const link = await prisma.conferenceDocument.findFirstOrThrow({
      where: { conferenceId, documentId: document.id },
    });
    const conference = await prisma.conference.findUniqueOrThrow({
      where: { id: conferenceId },
    });

    expect(finished).toBeGreaterThanOrEqual(1);
    expect(conference.status).toBe('ENDED');
    expect(storedText(row.yjsState)).toBe('до автозавершения');
    expect(link.firstEditedAt).toEqual(expect.any(Date));
    expect(
      await prisma.conferenceDocument.count({ where: { conferenceId } }),
    ).toBe(1);
  });
});
