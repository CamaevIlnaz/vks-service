import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { appConfig } from './config/app.config.js';
import { authConfig } from './config/auth.config.js';
import { livekitConfig } from './config/livekit.config.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ConferencesModule } from './modules/conferences/conferences.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { RoomsModule } from './modules/rooms/rooms.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, authConfig, livekitConfig],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    UsersModule,
    AuthModule,
    RoomsModule,
    ConferencesModule,
    MediaModule,
  ],
})
export class AppModule {}
