import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConferencesModule } from '../conferences/conferences.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { RoomAccessModule } from './room-access.module.js';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [PrismaModule, RoomAccessModule, ConferencesModule, DocumentsModule],
  controllers: [RoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
