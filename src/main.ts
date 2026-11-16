import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { setupApp } from './app.setup.js';
import {
  CSRF_HEADER,
  REFRESH_TOKEN_COOKIE,
} from './modules/auth/auth.constants.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  await setupApp(app);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);
  const port = configService.getOrThrow<number>('app.port');
  const swaggerPath = configService.getOrThrow<string>('app.swaggerPath');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('VKS Service')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth(REFRESH_TOKEN_COOKIE)
    .addApiKey({ type: 'apiKey', in: 'header', name: CSRF_HEADER }, 'csrf')
    .build();

  SwaggerModule.setup(
    swaggerPath,
    app,
    () => SwaggerModule.createDocument(app, swaggerConfig),
    { useGlobalPrefix: false },
  );

  await app.listen(port, '0.0.0.0');
}

await bootstrap();
