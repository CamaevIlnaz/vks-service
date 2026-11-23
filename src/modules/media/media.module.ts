import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConferencesModule } from '../conferences/conferences.module.js';
import { LivekitWebhookController } from './livekit-webhook.controller.js';
import { LivekitService } from './livekit.service.js';
import { MediaController } from './media.controller.js';
import { MediaPresenceService } from './media-presence.service.js';
import { MediaScheduler } from './media.scheduler.js';
import { MediaService } from './media.service.js';

@Module({
  imports: [PrismaModule, forwardRef(() => ConferencesModule)],
  controllers: [MediaController, LivekitWebhookController],
  providers: [
    LivekitService,
    MediaPresenceService,
    MediaService,
    MediaScheduler,
  ],
  exports: [MediaService, LivekitService, MediaPresenceService],
})
export class MediaModule {}
