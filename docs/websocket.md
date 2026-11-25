# WebSocket конференций

Протокол — Socket.IO 4, транспорт `websocket`. Сокет слушает тот же хост и порт, что и HTTP. Префикс API на него не действует: namespace `/conferences`, служебный путь Engine.IO — `/socket.io/`.

Медиазвонок сюда не подключается. Адрес LiveKit и короткоживущий JWT выдаёт `POST /media/token` — метод описан в Swagger.

Совместное редактирование документов тоже ходит отдельным сокетом. Адрес Hocuspocus и токен выдаёт `POST /rooms/:roomId/documents/:documentId/access`, протокол описан в [документации документов](/hocuspocus-docs/).

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/conferences', {
  transports: ['websocket'],
  reconnection: true,
  auth: { token: accessToken }, // или { guestToken }, или {}
});
```

Одно сообщение — не больше 64 КБ. `Origin` сверяется со списком `CORS_ORIGINS`. Запрос без `Origin` пришёл не из браузера: он пропускается, а личность берётся только из токена handshake.

## Подключение

| Кто                             | Handshake                                                                   |
| ------------------------------- | --------------------------------------------------------------------------- |
| Пользователь                    | `auth.token` — access token, либо заголовок `Authorization: Bearer <token>` |
| Гость, которому уже выдан токен | `auth.guestToken`, либо заголовок `x-guest-token`                           |
| Новый гость                     | пустой `auth`                                                               |

Недействительный access token отклоняет handshake: клиент обновляет токен и подключается снова. Недействительный гостевой токен игнорируется, сервер заводит нового гостя.

Ошибка handshake приходит в `connect_error`: текст в `error.message`, код в `error.data.statusCode` (`401`, `403` или `500`).

После каждого `connect`, в том числе после переподключения, клиент заново отправляет `conference:join`. Сокет сам в комнату не возвращается. Гостевой токен из ответа нужно сохранить и передавать в следующем handshake, иначе появится новый гость.

## Клиент → сервер

Оба события ждут ack. Ошибка приходит и событием `exception`, и в ack как `{ error }`.

```json
{ "status": "error", "statusCode": 400, "message": "Гостю нужно указать имя" }
```

`message` — строка или массив строк.

### `conference:join`

Вход в комнату по ссылке. Ack совпадает с ответом REST-входа.

```json
{
  "slug": "team-standup",
  "guestName": "Гость Пётр",
  "deviceType": "DESKTOP"
}
```

| Поле         | Правила                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `slug`       | обязателен, 3–64 символа, только `a-z`, `0-9` и дефис между частями                                  |
| `guestName`  | обязателен для гостя, до 100 символов. У пользователя игнорируется: имя берётся из профиля           |
| `deviceType` | необязателен: `DESKTOP`, `MOBILE`, `TABLET`, `UNKNOWN`. Если поля нет — определяется по `User-Agent` |

Ack:

```json
{
  "conferenceId": "uuid",
  "conferenceStatus": "ACTIVE",
  "participantId": "uuid",
  "role": "PARTICIPANT",
  "sessionId": "uuid",
  "room": {
    "name": "Планёрка",
    "slug": "team-standup",
    "type": "PERMANENT",
    "accessType": "OPEN",
    "status": "ACTIVE",
    "hasActiveConference": true,
    "canJoin": true
  },
  "guestToken": null
}
```

`guestToken` есть только у гостя и живёт 24 часа. `sessionId` — подключение этого сокета; тот же id принимает REST-выход. `role` — `HOST`, `MODERATOR` или `PARTICIPANT`. `conferenceStatus` — `ACTIVE`, `EMPTY` или `ENDED`.

Повторный `conference:join` того же сокета в ту же комнату новую сессию не создаёт и возвращает актуальное состояние. Вход в другую комнату сначала закрывает текущую сессию.

Сразу после входа этому сокету дополнительно приходит `conference:state`.

### `conference:leave`

Тела нет. Ack: `{ "left": true }` или `{ "left": false }`, если сокет ни в какой конференции не был.

Разрыв соединения делает то же самое: сессия закрывается, сокет уходит из присутствия.

## Сервер → клиент

События рассылаются комнате `conference:<conferenceId>`. Сокет, из-за которого событие возникло, его не получает — кроме случаев, указанных ниже.

### `conference:state`

Только сокету, который вошёл или повторил `conference:join`. Это полный снимок: в `participants` только те, кто сейчас онлайн. Несколько устройств одного участника — одна запись, `connectionsCount` больше 1.

```json
{
  "conferenceId": "uuid",
  "roomId": "uuid",
  "status": "ACTIVE",
  "participantsCount": 1,
  "participants": [
    {
      "id": "uuid",
      "userId": 1,
      "guestId": null,
      "name": "Иван Иванов",
      "role": "PARTICIPANT",
      "connectionsCount": 1
    }
  ]
}
```

У гостя `userId` равен `null`, у пользователя `guestId` равен `null`.

### `participant:joined`

Остальным в комнате, когда у участника появилось первое подключение.

```json
{
  "conferenceId": "uuid",
  "participant": {
    "id": "uuid",
    "userId": 1,
    "guestId": null,
    "name": "Иван Иванов",
    "role": "PARTICIPANT",
    "connectionsCount": 1
  },
  "participantsCount": 2
}
```

### `participant:updated`

Остальным, если у участника открылось ещё одно устройство. Всем в комнате, если закрылось одно из нескольких подключений и участник ещё онлайн. Форма та же, что у `participant:joined`.

### `participant:left`

Всем в комнате, когда закрылось последнее подключение участника.

```json
{
  "conferenceId": "uuid",
  "participantId": "uuid",
  "participantsCount": 1
}
```

### `conference:updated`

Смена статуса конференции, например когда комната опустела.

```json
{
  "conferenceId": "uuid",
  "roomId": "uuid",
  "status": "EMPTY",
  "emptyAt": "2026-11-24T10:00:00.000Z"
}
```

`emptyAt` — строка даты или `null`. `status` — `ACTIVE`, `EMPTY` или `ENDED`.

### `conference:ended`

Конференция завершена. После события сокеты выводятся из комнаты, присутствие этой конференции сбрасывается.

```json
{
  "conferenceId": "uuid",
  "status": "ENDED",
  "endedAt": "2026-11-24T10:00:00.000Z"
}
```

Чужой сокет — отзыв сессии или выход через REST по этому `sessionId` — сервер ещё и отключает. Причина disconnect: `io server disconnect`.

### `message:created`

Новое сообщение чата. Сокету автора уходит с `isMine: true`, остальным — с `isMine: false`. Поля те же, что у сообщения в REST, плюс `conferenceId`.

```json
{
  "id": "uuid",
  "conferenceId": "uuid",
  "content": "Всем привет!",
  "createdAt": "2026-11-24T10:00:00.000Z",
  "isMine": false,
  "author": {
    "participantId": "uuid",
    "displayName": "Иван Иванов",
    "avatarUrl": null,
    "isGuest": false
  }
}
```

История по-прежнему читается через REST: `GET /conferences/:id/messages`.

### `exception`

Ошибка обработчика, если клиент не передал ack.

```json
{
  "status": "error",
  "statusCode": 403,
  "message": "Учётная запись заблокирована"
}
```

## Порядок на клиенте

1. Подключиться с `auth`.
2. На `connect` отправить `conference:join`.
3. Из ack сохранить `sessionId` и `conferenceId`. Гостю ещё сохранить `guestToken`.
4. `conference:state` считать полным снимком. Дальше применять `participant:joined`, `participant:updated`, `participant:left`, `conference:updated`, `conference:ended` и `message:created`.
5. Выход — `conference:leave` или `disconnect`.
6. На `connect_error` с `data.statusCode === 401` обновить access token и подключиться снова.
