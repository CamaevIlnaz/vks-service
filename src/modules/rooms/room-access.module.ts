import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RoomAccessService } from './room-access.service.js';

@Module({
  imports: [PrismaModule],
  providers: [RoomAccessService],
  exports: [RoomAccessService],
})
export class RoomAccessModule {}
