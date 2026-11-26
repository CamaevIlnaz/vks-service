import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RoomAccessModule } from '../rooms/room-access.module.js';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';

@Module({
  imports: [PrismaModule, RoomAccessModule],
  controllers: [MeetingsController],
  providers: [MeetingsService],
})
export class MeetingsModule {}
