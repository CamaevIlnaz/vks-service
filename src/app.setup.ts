import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AVATAR_MAX_BYTES } from './modules/users/avatar-file.js';

export async function setupApp(app: NestFastifyApplication): Promise<void> {
  const uploadsDir = path.join(process.cwd(), 'uploads');
  await mkdir(uploadsDir, { recursive: true });

  await app.register(fastifyCookie);
  await app.register(multipart, {
    limits: { files: 1, fileSize: AVATAR_MAX_BYTES },
  });
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.setGlobalPrefix(
    app.get(ConfigService).getOrThrow<string>('app.apiPrefix'),
  );
}
