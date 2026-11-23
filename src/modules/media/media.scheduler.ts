import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { livekitErrorMessage } from './livekit.service.js';
import { MediaService } from './media.service.js';

@Injectable()
export class MediaScheduler {
  private readonly logger = new Logger(MediaScheduler.name);
  private running = false;

  constructor(private readonly mediaService: MediaService) {}

  /** Webhook может потеряться, поэтому состояние комнат периодически сверяется с API. */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleTick(): Promise<void> {
    if (process.env.VITEST || this.running) {
      return;
    }

    this.running = true;

    try {
      await this.mediaService.reconcile();
    } catch (error) {
      this.logger.error(`Ошибка сверки LiveKit: ${livekitErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }
}
