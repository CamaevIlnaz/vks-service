import { SetMetadata } from '@nestjs/common';
import { IS_OPTIONAL_AUTH_KEY } from '../auth.constants.js';

/** Маршрут доступен без access token, но переданный токен проверяется как обычно. */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
