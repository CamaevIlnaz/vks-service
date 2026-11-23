/** Время на установку WebRTC-соединения, а не длительность звонка. */
export const MEDIA_TOKEN_TTL_SECONDS = 5 * 60;

/** Короткий таймаут, чтобы недоступный LiveKit не держал блокировку комнаты. */
export const LIVEKIT_REQUEST_TIMEOUT_SECONDS = 3;

/** Content-Type, с которым LiveKit Server отправляет webhook по умолчанию. */
export const LIVEKIT_WEBHOOK_CONTENT_TYPE = 'application/webhook+json';
