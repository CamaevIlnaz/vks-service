import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConferenceSessionsService } from './conference-sessions.service.js';
import { ConferencesController } from './conferences.controller.js';
import { ConferencesScheduler } from './conferences.scheduler.js';
import { ConferencesService } from './conferences.service.js';
import { ConferenceActorGuard } from './guards/conference-actor.guard.js';
import {
  GUEST_TOKEN_AUDIENCE,
  GUEST_TOKEN_TTL_SECONDS,
  GuestTokensService,
} from './guest-tokens.service.js';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { RoomConferencesController } from './room-conferences.controller.js';

@Module({
  imports: [
    PrismaModule,
    // Отдельный секрет и audience: гостевой токен нельзя выдать за access token и наоборот.
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('auth.guestTokenSecret'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: GUEST_TOKEN_TTL_SECONDS,
          audience: GUEST_TOKEN_AUDIENCE,
        },
        verifyOptions: {
          algorithms: ['HS256'],
          audience: GUEST_TOKEN_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [
    RoomConferencesController,
    ConferencesController,
    MessagesController,
  ],
  providers: [
    ConferencesService,
    MessagesService,
    GuestTokensService,
    ConferenceActorGuard,
    ConferencesScheduler,
    ConferenceSessionsService,
  ],
  exports: [ConferenceSessionsService],
})
export class ConferencesModule {}
