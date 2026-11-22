import fastifyCookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SocketIoAdapter } from './common/socket-io.adapter.js';
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

  const publicDir = path.join(process.cwd(), 'public');
  await mkdir(publicDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/public/',
    decorateReply: false,
    cacheControl: false,
    setHeaders(reply) {
      reply.header('Cache-Control', 'no-store');
    },
  });

  app
    .getHttpAdapter()
    .getInstance()
    .get('/', (_request, reply) => {
      void reply.redirect('/public/');
    });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const configService = app.get(ConfigService);

  app.setGlobalPrefix(configService.getOrThrow<string>('app.apiPrefix'));
  app.useWebSocketAdapter(
    new SocketIoAdapter(
      app,
      configService.getOrThrow<string[]>('app.corsOrigins'),
    ),
  );
}
