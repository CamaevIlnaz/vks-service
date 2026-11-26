import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConferencesModule } from '../conferences/conferences.module.js';
import { RoomAccessModule } from '../rooms/room-access.module.js';
import {
  CollaborationAuthService,
  DOCUMENT_TOKEN_AUDIENCE,
} from './collaboration/collaboration-auth.service.js';
import { CollaborationService } from './collaboration/collaboration.service.js';
import { CollaborationStorageService } from './collaboration/collaboration-storage.service.js';
import { ConferenceDocumentsService } from './conference-documents.service.js';
import {
  ConferenceDocumentsController,
  DocumentsController,
} from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  imports: [
    PrismaModule,
    RoomAccessModule,
    forwardRef(() => ConferencesModule),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('auth.jwtAccessSecret'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: configService.getOrThrow<number>(
            'collaboration.tokenTtlSeconds',
          ),
          audience: DOCUMENT_TOKEN_AUDIENCE,
        },
        verifyOptions: {
          algorithms: ['HS256'],
          audience: DOCUMENT_TOKEN_AUDIENCE,
        },
      }),
    }),
  ],
  controllers: [DocumentsController, ConferenceDocumentsController],
  providers: [
    DocumentsService,
    ConferenceDocumentsService,
    CollaborationAuthService,
    CollaborationStorageService,
    CollaborationService,
  ],
  exports: [CollaborationService],
})
export class DocumentsModule {}
