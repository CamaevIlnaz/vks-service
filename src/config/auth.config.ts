import { registerAs } from '@nestjs/config';

const MIN_SECRET_LENGTH = 32;

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Не задано значение ${name}`);
  }

  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} должен содержать не менее ${MIN_SECRET_LENGTH} символов`,
    );
  }

  return value;
}

export const authConfig = registerAs('auth', () => {
  const jwtAccessSecret = requiredSecret('JWT_ACCESS_SECRET');
  const csrfSecret = requiredSecret('CSRF_SECRET');

  if (jwtAccessSecret === csrfSecret) {
    throw new Error('JWT_ACCESS_SECRET и CSRF_SECRET не должны совпадать');
  }

  return { jwtAccessSecret, csrfSecret };
});
