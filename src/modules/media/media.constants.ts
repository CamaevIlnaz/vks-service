/**
 * Время на установку WebRTC-соединения, а не длительность звонка.
 * После отзыва допуска новый токен не выдаётся. Уже выданный действует не дольше
 * этого срока, а повторное подключение сверяет сессию и допуск к комнате.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 5 * 60;

/** Короткий таймаут, чтобы недоступный LiveKit не держал блокировку комнаты. */
export const LIVEKIT_REQUEST_TIMEOUT_SECONDS = 3;

/** Content-Type, с которым LiveKit Server отправляет webhook по умолчанию. */
export const LIVEKIT_WEBHOOK_CONTENT_TYPE = 'application/webhook+json';
