import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConferencesModule } from '../conferences/conferences.module.js';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [PrismaModule, ConferencesModule],
  controllers: [RoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
