const { useCallback, useEffect, useRef, useState } = React;
const html = htm.bind(React.createElement);

const API = '/api';
const AUTH_KEY = 'vks-test-auth';
const CALL_KEY = 'vks-test-call';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ACCESS_LABEL = { OPEN: 'Открытая', CLOSED: 'Закрытая' };
const TYPE_LABEL = { PERMANENT: 'Постоянная', TEMPORARY: 'Временная' };
const STATUS_LABEL = { ACTIVE: 'Активна', EMPTY: 'Пустая', ENDED: 'Завершена' };
const ROLE_LABEL = {
  HOST: 'Организатор',
  MODERATOR: 'Модератор',
  PARTICIPANT: 'Участник',
};

function label(map, value) {
  return map[value] || value || '';
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function readAuth() {
  const auth = readJson(localStorage, AUTH_KEY);
  if (!auth?.accessToken || !auth.user) {
    localStorage.removeItem(AUTH_KEY);
    return null;
  }
  return auth;
}

function readCall() {
  const call = readJson(sessionStorage, CALL_KEY);
  if (!call?.room?.slug) {
    sessionStorage.removeItem(CALL_KEY);
    return null;
  }
  return call;
}

function writeAuth(auth) {
  if (!auth) localStorage.removeItem(AUTH_KEY);
  else localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

function writeCall(call) {
  if (!call) sessionStorage.removeItem(CALL_KEY);
  else sessionStorage.setItem(CALL_KEY, JSON.stringify(call));
}

function roomUrl(slug) {
  return `${location.origin}/public/?slug=${encodeURIComponent(slug)}`;
}

function normalizeSlugInput(value) {
  return value.toLowerCase().replace(/\s+/g, '');
}

function optionalSlugError(value) {
  const slug = value.trim();
  if (!slug) return '';
  if (slug.length < 3 || slug.length > 64 || !SLUG_RE.test(slug)) {
    return 'Ссылка: 3–64 символа, латиница в нижнем регистре, цифры и одиночные дефисы';
  }
  return '';
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function roomMeta(room) {
  const parts = [
    label(TYPE_LABEL, room.type),
    label(ACCESS_LABEL, room.accessType),
    label(STATUS_LABEL, room.status),
  ];
  if (room.activeConference) {
    parts.push(
      `конференция ${label(STATUS_LABEL, room.activeConference.status)}`,
    );
  }
  return parts.join(' · ');
}

const GUEST_KEY = 'vks-test-guests';

function readGuestToken(slug) {
  const map = readJson(sessionStorage, GUEST_KEY);
  const token = map?.[slug];
  return typeof token === 'string' ? token : '';
}

function writeGuestToken(slug, token) {
  const map = readJson(sessionStorage, GUEST_KEY) || {};
  map[slug] = token;
  sessionStorage.setItem(GUEST_KEY, JSON.stringify(map));
}

async function request(path, { method = 'GET', token, guestToken, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (guestToken) headers['x-guest-token'] = guestToken;

  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Не удалось связаться с сервером');
    }
    throw error;
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message;
    const text = Array.isArray(message)
      ? message.join('\n')
      : message || `Ошибка ${response.status}`;
    const error = new Error(text);
    error.status = response.status;
    throw error;
  }
  return data;
}

function useClient(credentials, onUnauthorized) {
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const accessToken = credentials?.accessToken || '';
  const guestToken = credentials?.guestToken || '';

  return useCallback(
    async (path, options) => {
      try {
        return await request(path, {
          ...options,
          token: accessToken || undefined,
          guestToken: accessToken ? undefined : guestToken || undefined,
        });
      } catch (error) {
        if (error.status === 401) onUnauthorizedRef.current();
        throw error;
      }
    },
    [accessToken, guestToken],
  );
}

function ErrorText({ children }) {
  if (!children) return null;
  return html`<p className="error">${children}</p>`;
}

function AccessSelect({ value, onChange, disabled }) {
  return html`<select
    value=${value}
    disabled=${disabled}
    onChange=${(event) => onChange(event.target.value)}
  >
    <option value="OPEN">Открытая</option>
    <option value="CLOSED">Закрытая</option>
  </select>`;
}

function Topbar({ title, user, children }) {
  return html`<header className="topbar">
    <div>
      <p className="brand">VKS</p>
      <h1>${title}</h1>
      ${user
        ? html`<p className="muted">${user.name} · ${user.email}</p>`
        : null}
    </div>
    <div className="topbar-actions">${children}</div>
  </header>`;
}

function AuthScreen({ notice, onSuccess, slug, onGuestJoin, onJoinByLink }) {
  const [mode, setMode] = useState(slug ? 'guest' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestSlug, setGuestSlug] = useState(slug || '');
  const [guestError, setGuestError] = useState('');
  const [room, setRoom] = useState(null);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    if (mode !== 'guest') return undefined;
    const normalized = guestSlug.trim();
    if (!normalized || optionalSlugError(normalized)) {
      setRoom(null);
      setPreviewError('');
      return undefined;
    }

    let cancelled = false;
    request(`/rooms/by-slug/${encodeURIComponent(normalized)}`)
      .then((data) => {
        if (cancelled) return;
        setRoom(data);
        setPreviewError('');
      })
      .catch((loadError) => {
        if (cancelled) return;
        setRoom(null);
        setPreviewError(loadError.message);
      });

    return () => {
      cancelled = true;
    };
  }, [mode, guestSlug]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const data = await request(
        mode === 'login' ? '/auth/login' : '/auth/register',
        {
          method: 'POST',
          body:
            mode === 'login'
              ? { email, password }
              : { email, password, name: name.trim() },
        },
      );
      onSuccess({
        accessToken: data.accessToken,
        csrfToken: data.csrfToken,
        user: data.user,
      });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setPending(false);
    }
  }

  async function joinAsGuest(event) {
    event.preventDefault();
    const normalized = guestSlug.trim();
    const displayName = guestName.trim();
    const slugError = optionalSlugError(normalized);
    if (!normalized || slugError) {
      setGuestError(slugError || 'Укажите ссылку комнаты');
      return;
    }
    if (!displayName) {
      setGuestError('Укажите имя');
      return;
    }

    setGuestError('');
    onGuestJoin({
      room: room
        ? {
            slug: room.slug,
            name: room.name,
            type: room.type,
            accessType: room.accessType,
            status: room.status,
          }
        : { slug: normalized, name: normalized },
      guestName: displayName,
      guestToken: readGuestToken(normalized) || null,
    });
  }

  function switchMode(next) {
    setMode(next);
    setError('');
    setGuestError('');
  }

  const guestBlocked = Boolean(room && !room.canJoin);

  return html`<main className="narrow">
    <p className="brand">VKS</p>
    <h1>${mode === 'guest' ? 'Вход гостя' : 'Тест API'}</h1>
    <p className="muted">
      ${mode === 'guest'
        ? 'Подключение к комнате без аккаунта.'
        : 'Вход и комнаты. Звонок идёт по WebSocket.'}
    </p>
    <div className="tabs">
      <button
        type="button"
        className=${mode === 'login' ? 'tab active' : 'tab'}
        onClick=${() => switchMode('login')}
      >
        Вход
      </button>
      <button
        type="button"
        className=${mode === 'register' ? 'tab active' : 'tab'}
        onClick=${() => switchMode('register')}
      >
        Регистрация
      </button>
      <button
        type="button"
        className=${mode === 'guest' ? 'tab active' : 'tab'}
        onClick=${() => switchMode('guest')}
      >
        Гость
      </button>
    </div>
    ${mode === 'guest'
      ? html`<form className="card" onSubmit=${joinAsGuest}>
          <label className="field">
            <span>Ссылка комнаты</span>
            <input
              required
              minLength="3"
              maxLength="64"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              title="Латиница в нижнем регистре, цифры и одиночные дефисы"
              spellcheck=${false}
              value=${guestSlug}
              onChange=${(event) =>
                setGuestSlug(normalizeSlugInput(event.target.value))}
            />
          </label>
          ${room
            ? html`<p className="muted">
                ${room.name} · ${label(ACCESS_LABEL, room.accessType)}${room.canJoin
                  ? ''
                  : ' · подключиться нельзя'}
              </p>`
            : null}
          <label className="field">
            <span>Имя</span>
            <input
              required
              maxLength="100"
              autocomplete="name"
              value=${guestName}
              onChange=${(event) => setGuestName(event.target.value)}
            />
          </label>
          <p className="muted">Имя увидят другие участники.</p>
          <${ErrorText}>${previewError}</${ErrorText}>
          <${ErrorText}>${guestError}</${ErrorText}>
          <button type="submit" disabled=${guestBlocked}>Подключиться</button>
        </form>`
      : html`<form className="card" onSubmit=${submit}>
          ${mode === 'register'
            ? html`<label className="field">
                <span>Имя</span>
                <input
                  required
                  maxLength="100"
                  autocomplete="name"
                  value=${name}
                  onChange=${(event) => setName(event.target.value)}
                />
              </label>`
            : null}
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              maxLength="254"
              autocomplete="email"
              value=${email}
              onChange=${(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Пароль</span>
            <input
              type="password"
              required
              minLength=${mode === 'register' ? 8 : 1}
              maxLength="128"
              autocomplete=${mode === 'register'
                ? 'new-password'
                : 'current-password'}
              value=${password}
              onChange=${(event) => setPassword(event.target.value)}
            />
          </label>
          ${mode === 'register'
            ? html`<p className="muted">Минимум 8 символов.</p>`
            : null}
          <${ErrorText}>${notice}</${ErrorText}>
          <${ErrorText}>${error}</${ErrorText}>
          <button type="submit" disabled=${pending}>
            ${pending
              ? 'Подождите…'
              : mode === 'login'
                ? 'Войти'
                : 'Зарегистрироваться'}
          </button>
        </form>`}
    <p className="muted join-note">
      <button type="button" className="text" onClick=${onJoinByLink}>
        Подключиться по ссылке
      </button>
    </p>
  </main>`;
}

function JoinScreen({ auth, onJoin, onBack, onUnauthorized }) {
  const client = useClient(auth, onUnauthorized);
  const [slug, setSlug] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const normalized = slug.trim();
    const slugError = optionalSlugError(normalized);
    if (!normalized || slugError) {
      setError(slugError || 'Укажите ссылку комнаты');
      return;
    }

    setPending(true);
    setError('');
    try {
      const room = await client(
        `/rooms/by-slug/${encodeURIComponent(normalized)}`,
      );
      if (!room.canJoin) {
        setError('Подключиться к этой комнате нельзя');
        return;
      }
      onJoin({
        room: {
          slug: room.slug,
          name: room.name,
          type: room.type,
          accessType: room.accessType,
          status: room.status,
        },
        guestName: auth ? null : 'Гость',
        guestToken: auth ? null : readGuestToken(room.slug) || null,
      });
    } catch (joinError) {
      if (joinError.status !== 401) setError(joinError.message);
    } finally {
      setPending(false);
    }
  }

  return html`<main className="narrow">
    <p className="brand">VKS</p>
    <h1>Подключение по ссылке</h1>
    <p className="muted">Введите ссылку комнаты.</p>
    <form className="card" onSubmit=${submit}>
      <label className="field">
        <span>Ссылка комнаты</span>
        <input
          required
          autoFocus
          minLength="3"
          maxLength="64"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          title="Латиница в нижнем регистре, цифры и одиночные дефисы"
          spellcheck=${false}
          value=${slug}
          onChange=${(event) => setSlug(normalizeSlugInput(event.target.value))}
        />
      </label>
      <${ErrorText}>${error}</${ErrorText}>
      <div className="row">
        <button type="submit" disabled=${pending}>
          ${pending ? 'Подключение…' : 'Подключиться'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled=${pending}
          onClick=${onBack}
        >
          Назад
        </button>
      </div>
    </form>
  </main>`;
}

function RoomsScreen({ auth, onOpen, onJoinByLink, onLogout, onUnauthorized }) {
  const authed = useClient(auth, onUnauthorized);
  const [rooms, setRooms] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [accessType, setAccessType] = useState('OPEN');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const autoJoinStarted = useRef(false);

  async function loadRooms() {
    setLoading(true);
    try {
      const page = await authed('/rooms?limit=100');
      setRooms(page.items);
      setTotal(page.total);
      setListError('');
    } catch (error) {
      if (error.status !== 401) setListError(error.message);
    } finally {
      setLoading(false);
    }
  }

  function openRoom(roomOrSlug) {
    const source = typeof roomOrSlug === 'string' ? null : roomOrSlug;
    const slugValue = source ? source.slug : roomOrSlug;
    onOpen({
      room: {
        slug: slugValue,
        name: source?.name || slugValue,
        type: source?.type,
        accessType: source?.accessType,
        status: source?.status,
      },
      guestName: null,
      guestToken: null,
    });
  }

  useEffect(() => {
    void loadRooms();
    const slugFromUrl = new URLSearchParams(location.search).get('slug');
    if (!slugFromUrl || autoJoinStarted.current) return;
    autoJoinStarted.current = true;
    void openRoom(slugFromUrl);
  }, []);

  async function createRoom(event) {
    event.preventDefault();
    const payload = { name: name.trim(), accessType };
    const slugError = optionalSlugError(slug);
    if (!payload.name) {
      setActionError('Укажите название');
      return;
    }
    if (slugError) {
      setActionError(slugError);
      return;
    }
    if (slug.trim()) payload.slug = slug.trim();

    setCreating(true);
    setActionError('');
    try {
      await authed('/rooms', { method: 'POST', body: payload });
      setName('');
      setSlug('');
      setAccessType('OPEN');
      await loadRooms();
    } catch (error) {
      if (error.status !== 401) setActionError(error.message);
    } finally {
      setCreating(false);
    }
  }

  function startEdit(room) {
    setEditing({
      id: room.id,
      name: room.name,
      slug: room.slug,
      accessType: room.accessType,
    });
    setActionError('');
  }

  async function saveEdit(event) {
    event.preventDefault();
    if (!editing) return;
    const payload = {
      name: editing.name.trim(),
      slug: editing.slug.trim(),
      accessType: editing.accessType,
    };
    const slugError = optionalSlugError(payload.slug);
    if (!payload.name) {
      setActionError('Укажите название');
      return;
    }
    if (!payload.slug || slugError) {
      setActionError(slugError || 'Укажите ссылку');
      return;
    }

    setSavingEdit(true);
    setActionError('');
    try {
      await authed(`/rooms/${editing.id}`, { method: 'PATCH', body: payload });
      setEditing(null);
      await loadRooms();
    } catch (error) {
      if (error.status !== 401) setActionError(error.message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function removeRoom(room) {
    if (!window.confirm(`Удалить комнату «${room.name}»?`)) return;
    setDeletingId(room.id);
    setActionError('');
    try {
      await authed(`/rooms/${room.id}`, { method: 'DELETE' });
      if (editing?.id === room.id) setEditing(null);
      await loadRooms();
    } catch (error) {
      if (error.status !== 401) setActionError(error.message);
    } finally {
      setDeletingId(null);
    }
  }

  return html`<main className="page">
    <${Topbar} title="Комнаты" user=${auth.user}>
      <button type="button" className="ghost" onClick=${onJoinByLink}>
        По ссылке
      </button>
      <button type="button" className="ghost" onClick=${onLogout}>Выйти</button>
    </${Topbar}>

    <form className="card create-form" onSubmit=${createRoom}>
      <h2>Новая комната</h2>
      <label className="field">
        <span>Название</span>
        <input
          required
          maxLength="100"
          value=${name}
          onChange=${(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span>Ссылка</span>
        <input
          minLength="3"
          maxLength="64"
          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
          title="Латиница в нижнем регистре, цифры и одиночные дефисы"
          placeholder="Если пусто — сервер сгенерирует"
          spellcheck=${false}
          value=${slug}
          onChange=${(event) => setSlug(normalizeSlugInput(event.target.value))}
        />
      </label>
      <label className="field">
        <span>Доступ</span>
        <${AccessSelect} value=${accessType} onChange=${setAccessType} />
      </label>
      <button type="submit" disabled=${creating}>
        ${creating ? 'Создание…' : 'Создать'}
      </button>
    </form>

    <${ErrorText}>${actionError}</${ErrorText}>
    <${ErrorText}>${listError}</${ErrorText}>

    <h2>
      Ваши комнаты
      <span className="count">${total}</span>
    </h2>
    ${loading && rooms.length === 0
      ? html`<p className="muted">Загрузка…</p>`
      : null}
    ${!loading && rooms.length === 0
      ? html`<p className="muted">Комнат пока нет.</p>`
      : null}
    <div className="room-list">
      ${rooms.map((room) =>
        editing?.id === room.id
          ? html`<form
              key=${room.id}
              className="card room-edit"
              onSubmit=${saveEdit}
            >
              <h2>Изменить комнату</h2>
              <label className="field">
                <span>Название</span>
                <input
                  required
                  maxLength="100"
                  value=${editing.name}
                  onChange=${(event) =>
                    setEditing({ ...editing, name: event.target.value })}
                />
              </label>
              <label className="field">
                <span>Ссылка</span>
                <input
                  required
                  minLength="3"
                  maxLength="64"
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  spellcheck=${false}
                  value=${editing.slug}
                  onChange=${(event) =>
                    setEditing({
                      ...editing,
                      slug: normalizeSlugInput(event.target.value),
                    })}
                />
              </label>
              <label className="field">
                <span>Доступ</span>
                <${AccessSelect}
                  value=${editing.accessType}
                  onChange=${(value) =>
                    setEditing({ ...editing, accessType: value })}
                />
              </label>
              <div className="row">
                <button type="submit" disabled=${savingEdit}>
                  ${savingEdit ? 'Сохранение…' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled=${savingEdit}
                  onClick=${() => setEditing(null)}
                >
                  Отмена
                </button>
              </div>
            </form>`
          : html`<article key=${room.id} className="card room">
              <button
                type="button"
                className="room-open"
                onClick=${() => openRoom(room)}
              >
                <strong>${room.name}</strong>
                <code>${room.slug}</code>
                <span className="muted">${roomMeta(room)}</span>
              </button>
              <div className="room-actions">
                <button
                  type="button"
                  className="ghost"
                  disabled=${room.status === 'ENDED' || deletingId !== null}
                  onClick=${() => startEdit(room)}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled=${deletingId === room.id}
                  onClick=${() => removeRoom(room)}
                >
                  ${deletingId === room.id ? 'Удаление…' : 'Удалить'}
                </button>
              </div>
            </article>`,
      )}
    </div>
    ${total > rooms.length
      ? html`<p className="muted">Показаны ${rooms.length} из ${total}.</p>`
      : null}
  </main>`;
}

function wsErrorText(error) {
  const message = error?.message;
  if (Array.isArray(message)) return message.join('\n');
  return message || 'Ошибка соединения';
}

function CallScreen({ auth, call, onLeave, onUpdate, onLogout, onUnauthorized }) {
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageTotal, setMessageTotal] = useState(0);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState(false);
  const [connected, setConnected] = useState(false);
  const [conferenceStatus, setConferenceStatus] = useState(
    call.conferenceStatus || null,
  );
  const [myParticipantId, setMyParticipantId] = useState(
    call.participantId || null,
  );
  const [sessionId, setSessionId] = useState(call.sessionId || null);
  const listRef = useRef(null);
  const socketRef = useRef(null);
  const leavingRef = useRef(false);
  const accessTokenRef = useRef(auth?.accessToken || '');
  const guestTokenRef = useRef(
    call.guestToken || readGuestToken(call.room.slug) || '',
  );
  const conferenceIdRef = useRef(call.conferenceId || null);
  const onLeaveRef = useRef(onLeave);
  const onUpdateRef = useRef(onUpdate);
  const onUnauthorizedRef = useRef(onUnauthorized);
  accessTokenRef.current = auth?.accessToken || '';
  onLeaveRef.current = onLeave;
  onUpdateRef.current = onUpdate;
  onUnauthorizedRef.current = onUnauthorized;
  const link = roomUrl(call.room.slug);
  const slug = call.room.slug;
  const guestName = call.guestName || '';

  function rememberMessage(message) {
    setMessages((current) => {
      if (current.some((item) => item.id === message.id)) return current;
      return [message, ...current];
    });
  }

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (typeof io !== 'function') {
      setError('Не загружен клиент WebSocket');
      return undefined;
    }

    let disposed = false;
    const knownMessageIds = new Set();
    const socket = io(`${location.origin}/conferences`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      auth: (callback) => {
        if (accessTokenRef.current) {
          callback({ token: accessTokenRef.current });
          return;
        }
        if (guestTokenRef.current) {
          callback({ guestToken: guestTokenRef.current });
          return;
        }
        callback({});
      },
    });
    socketRef.current = socket;

    function upsertParticipant(participant) {
      setParticipants((current) => {
        const index = current.findIndex((item) => item.id === participant.id);
        if (index === -1) return [...current, participant];
        const next = current.slice();
        next[index] = participant;
        return next;
      });
    }

    async function loadHistory(conferenceId) {
      try {
        const page = await request(
          `/conferences/${conferenceId}/messages?limit=100`,
          accessTokenRef.current
            ? { token: accessTokenRef.current }
            : { guestToken: guestTokenRef.current || undefined },
        );
        if (disposed) return;
        for (const item of page.items) knownMessageIds.add(item.id);
        setMessages((current) => {
          const byId = new Map(page.items.map((item) => [item.id, item]));
          for (const item of current) byId.set(item.id, item);
          return [...byId.values()].sort(
            (left, right) =>
              new Date(right.createdAt) - new Date(left.createdAt),
          );
        });
        setMessageTotal(page.total);
      } catch (loadError) {
        if (!disposed && loadError.status !== 401) setError(loadError.message);
        if (loadError.status === 401) onUnauthorizedRef.current();
      }
    }

    function joinConference() {
      const payload = { slug };
      if (!accessTokenRef.current) {
        payload.guestName = guestName || 'Гость';
      }
      socket.timeout(8000).emit('conference:join', payload, (err, response) => {
        if (disposed) return;
        if (err) {
          setError('Не удалось войти в конференцию');
          return;
        }
        if (response?.error) {
          setError(wsErrorText(response.error));
          if (response.error.statusCode === 401) onUnauthorizedRef.current();
          return;
        }

        conferenceIdRef.current = response.conferenceId;
        guestTokenRef.current = response.guestToken || guestTokenRef.current;
        if (response.guestToken) writeGuestToken(slug, response.guestToken);
        setSessionId(response.sessionId);
        setMyParticipantId(response.participantId);
        setConferenceStatus(response.conferenceStatus);
        setJoined(true);
        setError('');
        onUpdateRef.current({
          conferenceId: response.conferenceId,
          conferenceStatus: response.conferenceStatus,
          sessionId: response.sessionId,
          participantId: response.participantId,
          role: response.role,
          guestToken: response.guestToken,
          room: response.room,
        });
        void loadHistory(response.conferenceId);
      });
    }

    socket.on('connect', () => {
      setConnected(true);
      joinConference();
    });
    socket.on('disconnect', (reason) => {
      setConnected(false);
      setJoined(false);
      if (disposed || leavingRef.current) return;
      if (reason === 'io server disconnect') {
        setError('Сервер закрыл соединение');
      }
    });
    socket.on('connect_error', (connectError) => {
      const statusCode = connectError?.data?.statusCode;
      if (statusCode === 401) {
        onUnauthorizedRef.current();
        return;
      }
      setError(connectError?.message || 'Не удалось открыть WebSocket');
    });
    socket.on('conference:state', (state) => {
      setParticipants(state.participants || []);
      setConferenceStatus(state.status);
    });
    socket.on('conference:updated', (payload) => {
      setConferenceStatus(payload.status);
    });
    socket.on('conference:ended', (payload) => {
      setConferenceStatus(payload.status || 'ENDED');
      setParticipants([]);
    });
    socket.on('participant:joined', (payload) => {
      if (payload.participant) upsertParticipant(payload.participant);
    });
    socket.on('participant:updated', (payload) => {
      if (payload.participant) upsertParticipant(payload.participant);
    });
    socket.on('participant:left', (payload) => {
      setParticipants((current) =>
        current.filter((item) => item.id !== payload.participantId),
      );
    });
    socket.on('message:created', (message) => {
      if (knownMessageIds.has(message.id)) return;
      knownMessageIds.add(message.id);
      rememberMessage(message);
      setMessageTotal((count) => count + 1);
    });

    return () => {
      disposed = true;
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [slug, guestName]);

  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    const conferenceId = conferenceIdRef.current;
    if (!content || !conferenceId) return;
    setSending(true);
    setError('');
    try {
      const created = await request(
        `/conferences/${conferenceId}/messages`,
        {
          method: 'POST',
          body: { content },
          ...(accessTokenRef.current
            ? { token: accessTokenRef.current }
            : { guestToken: guestTokenRef.current || undefined }),
        },
      );
      setDraft('');
      rememberMessage({ ...created, isMine: true });
    } catch (sendError) {
      if (sendError.status === 401) onUnauthorizedRef.current();
      else setError(sendError.message);
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form.requestSubmit();
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Не удалось скопировать ссылку');
    }
  }

  function leave() {
    leavingRef.current = true;
    setLeaving(true);
    setError('');
    const socket = socketRef.current;
    const finish = () => {
      socket?.disconnect();
      onLeaveRef.current();
    };
    if (!socket?.connected) {
      finish();
      return;
    }
    socket.timeout(8000).emit('conference:leave', () => finish());
  }

  const ordered = [...messages].reverse();

  return html`<main className="page">
    <${Topbar}
      title=${call.room.name}
      user=${auth?.user || { name: call.guestName || 'Гость', email: 'гость' }}
    >
      <button
        type="button"
        className="danger"
        disabled=${leaving}
        onClick=${leave}
      >
        ${leaving ? 'Выход…' : 'Выйти из звонка'}
      </button>
      <button type="button" className="ghost" onClick=${onLogout}>Выйти</button>
    </${Topbar}>

    <section className="link-card">
      <div>
        <span className="label">Ссылка</span>
        <code>${call.room.slug}</code>
      </div>
      <div className="link-actions">
        <input
          readOnly
          value=${link}
          onFocus=${(event) => event.target.select()}
        />
        <button type="button" className="ghost" onClick=${copyLink}>
          ${copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <p className="muted">
        ${joined
          ? `Конференция ${label(STATUS_LABEL, conferenceStatus)}`
          : 'Подключение к конференции…'}
        ${connected ? ' · сокет подключён' : ' · сокет отключён'}
        ${sessionId ? ` · ${sessionId}` : ''}
      </p>
    </section>

    <${ErrorText}>${error}</${ErrorText}>

    <div className="call-grid">
      <section className="panel participants">
        <h2>
          Участники <span className="count">${participants.length}</span>
        </h2>
        ${participants.length === 0
          ? html`<p className="muted">
              ${joined ? 'Пока никого нет' : 'Подключение…'}
            </p>`
          : html`<ul className="people">
              ${participants.map(
                (person) => html`<li
                  key=${person.id}
                  className=${person.id === myParticipantId ? 'me' : ''}
                >
                  <strong>${person.name}</strong>
                  <span>
                    ${label(ROLE_LABEL, person.role)}${person.guestId
                      ? ' · гость'
                      : ''}${person.id === myParticipantId ? ' · вы' : ''}
                  </span>
                  <span className="muted">
                    подключений: ${person.connectionsCount}
                  </span>
                </li>`,
              )}
            </ul>`}
      </section>

      <section className="panel messages">
        <h2>
          Сообщения <span className="count">${messageTotal}</span>
        </h2>
        ${messageTotal > messages.length
          ? html`<p className="muted">
              Показаны последние ${messages.length} из ${messageTotal}.
            </p>`
          : null}
        ${ordered.length === 0
          ? html`<p className="muted">Сообщений пока нет</p>`
          : html`<ul className="thread" ref=${listRef}>
              ${ordered.map(
                (message) => html`<li
                  key=${message.id}
                  className=${message.isMine ? 'mine' : ''}
                >
                  <div className="meta">
                    <strong>${message.author.displayName}</strong>
                    <time dateTime=${message.createdAt}>
                      ${formatTime(message.createdAt)}
                    </time>
                  </div>
                  <p>${message.content}</p>
                </li>`,
              )}
            </ul>`}
      </section>

      <form className="panel composer" onSubmit=${sendMessage}>
        <h2>Новое сообщение</h2>
        <textarea
          maxLength="2000"
          placeholder="Текст сообщения"
          value=${draft}
          disabled=${sending || leaving || !joined || conferenceStatus !== 'ACTIVE'}
          onChange=${(event) => setDraft(event.target.value)}
          onKeyDown=${onComposerKeyDown}
        ></textarea>
        <p className="muted">${draft.trim().length}/2000 · Enter — отправить</p>
        <button
          type="submit"
          disabled=${sending ||
          leaving ||
          !joined ||
          conferenceStatus !== 'ACTIVE' ||
          !draft.trim()}
        >
          ${sending ? 'Отправка…' : 'Отправить'}
        </button>
      </form>
    </div>
  </main>`;
}

function App() {
  const [auth, setAuth] = useState(readAuth);
  const [call, setCall] = useState(readCall);
  const [notice, setNotice] = useState('');
  const [joinByLink, setJoinByLink] = useState(false);

  function clearClient() {
    writeAuth(null);
    writeCall(null);
    setAuth(null);
    setCall(null);
  }

  function login(next) {
    writeAuth(next);
    setAuth(next);
    setNotice('');
  }

  function logout() {
    const current = auth;
    clearClient();
    setNotice('');
    if (!current?.csrfToken) return;
    fetch(`${API}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': current.csrfToken },
    }).catch(() => {});
  }

  function expire() {
    const wasGuest = !auth && call?.guestToken;
    clearClient();
    setNotice(
      wasGuest
        ? 'Гостевой токен недействителен'
        : 'Сессия истекла, войдите снова',
    );
  }

  function updateCall(patch) {
    setCall((current) => {
      if (!current) return current;
      const next = {
        ...current,
        ...patch,
        room: patch.room ? { ...current.room, ...patch.room } : current.room,
      };
      writeCall(next);
      return next;
    });
  }

  function openCall(next) {
    writeCall(next);
    setCall(next);
    const url = new URL(location.href);
    if (!url.searchParams.has('slug')) return;
    url.searchParams.delete('slug');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  function closeCall() {
    writeCall(null);
    setCall(null);
  }

  const slugFromUrl = new URLSearchParams(location.search).get('slug');

  if (joinByLink && !call) {
    return html`<${JoinScreen}
      auth=${auth}
      onJoin=${(next) => {
        setJoinByLink(false);
        openCall(next);
      }}
      onBack=${() => setJoinByLink(false)}
      onUnauthorized=${expire}
    />`;
  }
  if (call) {
    return html`<${CallScreen}
      auth=${auth}
      call=${call}
      onLeave=${closeCall}
      onUpdate=${updateCall}
      onLogout=${logout}
      onUnauthorized=${expire}
    />`;
  }
  if (!auth) {
    return html`<${AuthScreen}
      notice=${notice}
      slug=${slugFromUrl || ''}
      onSuccess=${login}
      onGuestJoin=${openCall}
      onJoinByLink=${() => setJoinByLink(true)}
    />`;
  }
  return html`<${RoomsScreen}
    auth=${auth}
    onOpen=${openCall}
    onLogout=${logout}
    onJoinByLink=${() => setJoinByLink(true)}
    onUnauthorized=${expire}
  />`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
