import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Database } from '@hocuspocus/extension-database';
import {
  Server,
  isTransactionOrigin,
  type onStoreDocumentPayload,
} from '@hocuspocus/server';
import { PrismaService } from '../../../prisma/prisma.service.js';
import {
  CollaborationAuthService,
  CollaborationDenied,
  isCollaborationContext,
  type CollaborationContext,
} from './collaboration-auth.service.js';
import { CollaborationStorageService } from './collaboration-storage.service.js';
import { documentName } from './document-name.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Один процесс Hocuspocus. Имя документа — `document:{id}` и не меняется между конференциями.
 * Debounce 2 с, но не реже одного сохранения в 10 с, пока правки идут непрерывно.
 */
@Injectable()
export class CollaborationService
  implements OnModuleInit, OnApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger(CollaborationService.name);
  private readonly sealed = new Set<string>();
  private readonly blockedSockets = new Set<string>();
  private server?: Server<CollaborationContext>;
  private stopped = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auth: CollaborationAuthService,
    private readonly storage: CollaborationStorageService,
  ) {
    this.auth.bindGate({
      isSealed: (conferenceId) => this.sealed.has(conferenceId),
    });
  }

  async onModuleInit(): Promise<void> {
    const port = this.configService.getOrThrow<number>('collaboration.port');
    const debounce = this.configService.getOrThrow<number>(
      'collaboration.debounceMs',
    );
    const maxDebounce = this.configService.getOrThrow<number>(
      'collaboration.maxDebounceMs',
    );

    this.server = new Server<CollaborationContext>({
      port,
      address: '0.0.0.0',
      quiet: true,
      stopOnSignals: false,
      debounce,
      maxDebounce,
      extensions: [
        new Database({
          fetch: ({ documentName: name }) => this.storage.fetch(name),
          store: (data) => this.storage.store(data),
        }),
      ],
      onAuthenticate: ({ token, documentName: name }) =>
        this.auth.authenticateSocket(token, name),
      beforeHandleMessage: ({ context, socketId, connection }) => {
        this.rejectIfBlocked(context, socketId, connection);
        return Promise.resolve();
      },
      beforeHandleAwareness: ({ context, socketId, connection }) => {
        if (!connection) {
          return Promise.resolve();
        }

        this.rejectIfBlocked(context, socketId, connection);
        return Promise.resolve();
      },
      afterLoadDocument: ({ documentName: name, document }) => {
        this.storage.rememberBaseline(name, document);
        return Promise.resolve();
      },
      afterUnloadDocument: ({ documentName: name }) => {
        this.storage.forget(name);
        return Promise.resolve();
      },
      onChange: ({
        documentName: name,
        document,
        context,
        update,
        transactionOrigin,
      }) => {
        if (!update.byteLength) {
          return Promise.resolve();
        }

        if (
          !isTransactionOrigin(transactionOrigin) ||
          transactionOrigin.source !== 'connection' ||
          !isCollaborationContext(context)
        ) {
          return Promise.resolve();
        }

        this.storage.noteContentChange(name, document, context.conferenceId);
        return Promise.resolve();
      },
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };

      this.server!.httpServer.once('error', onError);
      void this.server!.listen().then(
        () => {
          this.server!.httpServer.off('error', onError);
          resolve();
        },
        (error: unknown) => {
          this.server!.httpServer.off('error', onError);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

    this.logger.log(
      `Совместное редактирование: ${this.configService.getOrThrow<string>('collaboration.url')}`,
    );
  }

  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  isSealed(conferenceId: string): boolean {
    return this.sealed.has(conferenceId);
  }

  /**
   * Общий шаг ручного и автоматического завершения, а также удаления комнаты.
   * Сначала запрещает новые правки и сохраняет уже принятые, затем выполняет действие.
   * Если действие не завершило конференцию, запрет снимается.
   * Вызывать под блокировкой комнаты, не захватывая её повторно.
   */
  async withConferenceSeal<T>(
    conferenceId: string,
    action: () => Promise<T>,
    keepSeal: (result: T) => boolean,
  ): Promise<T> {
    const alreadySealed = this.sealed.has(conferenceId);

    await this.sealConference(conferenceId);

    try {
      const result = await action();

      if (!alreadySealed && !keepSeal(result)) {
        this.releaseSeal(conferenceId);
      }

      return result;
    } catch (error) {
      if (!alreadySealed) {
        this.releaseSeal(conferenceId);
      }

      throw error;
    }
  }

  /** Закрывает редакторов документа и дожидается записи актуального состояния. */
  async disconnectDocument(
    documentId: string,
    conferenceId?: string,
  ): Promise<void> {
    const names = new Set(
      this.closeMatching((context) => {
        if (context.documentId !== documentId) {
          return false;
        }

        return conferenceId ? context.conferenceId === conferenceId : true;
      }),
    );

    names.add(documentName(documentId));
    await this.flushNames(names);
  }

  /**
   * Участник без открытых сессий больше не редактирует.
   * Чужие устройства того же участника сохраняют доступ, пока хотя бы одна сессия жива.
   */
  async revokeParticipantsWithoutSessions(
    conferenceId: string,
    sessionIds: string[],
  ): Promise<void> {
    if (this.sealed.has(conferenceId) || sessionIds.length === 0) {
      return;
    }

    const sessions = await this.prisma.conferenceParticipantSession.findMany({
      where: { id: { in: sessionIds } },
      select: { participantId: true },
    });
    const participantIds = [
      ...new Set(sessions.map((session) => session.participantId)),
    ];
    const names = new Set<string>();

    for (const participantId of participantIds) {
      const openSessions = await this.prisma.conferenceParticipantSession.count(
        {
          where: {
            participantId,
            leftAt: null,
            participant: { conferenceId },
          },
        },
      );

      if (openSessions > 0) {
        continue;
      }

      for (const name of this.closeMatching(
        (context) =>
          context.conferenceId === conferenceId &&
          context.participantId === participantId,
      )) {
        names.add(name);
      }
    }

    await this.flushNames(names);
  }

  private async sealConference(conferenceId: string): Promise<void> {
    this.sealed.add(conferenceId);

    const names = new Set(
      this.closeMatching((context) => context.conferenceId === conferenceId),
    );

    for (const name of this.storage.namesPendingConference(conferenceId)) {
      names.add(name);
    }

    await this.flushNames(names);
  }

  private releaseSeal(conferenceId: string): void {
    this.sealed.delete(conferenceId);
  }

  private rejectIfBlocked(
    context: unknown,
    socketId: string,
    connection: { close: () => void },
  ): void {
    if (
      !isCollaborationContext(context) ||
      this.sealed.has(context.conferenceId) ||
      this.blockedSockets.has(socketId)
    ) {
      this.blockedSockets.add(socketId);
      connection.close();
      throw new CollaborationDenied('Редактирование недоступно');
    }
  }

  private closeMatching(
    predicate: (context: CollaborationContext) => boolean,
  ): string[] {
    const hocuspocus = this.server?.hocuspocus;

    if (!hocuspocus) {
      return [];
    }

    const names = new Set<string>();
    const documents = [...hocuspocus.documents.values()];

    for (const document of documents) {
      for (const connection of document.getConnections()) {
        if (
          !isCollaborationContext(connection.context) ||
          !predicate(connection.context)
        ) {
          continue;
        }

        this.blockedSockets.add(connection.socketId);
        names.add(document.name);
        connection.close();
        connection.webSocket.close();
      }
    }

    return [...names];
  }

  private async flushNames(names: Iterable<string>): Promise<void> {
    for (const name of names) {
      await this.flushDocument(name);
    }
  }

  private async flushDocument(name: string): Promise<void> {
    const hocuspocus = this.server?.hocuspocus;

    if (!hocuspocus) {
      return;
    }

    const debounceId = `onStoreDocument-${name}`;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (hocuspocus.debouncer.isDebounced(debounceId)) {
        await hocuspocus.debouncer.executeNow(debounceId);
        continue;
      }

      if (hocuspocus.debouncer.isCurrentlyExecuting(debounceId)) {
        await delay(25);
        continue;
      }

      if (!this.storage.hasUnsaved(name)) {
        return;
      }

      const document = hocuspocus.documents.get(name);

      if (!document) {
        return;
      }

      const payload: onStoreDocumentPayload<CollaborationContext> = {
        instance: hocuspocus,
        clientsCount: document.getConnectionsCount(),
        document,
        documentName: name,
        lastContext: undefined as unknown as CollaborationContext,
        lastTransactionOrigin: null,
      };

      await hocuspocus.storeDocumentHooks(document, payload, true);
    }

    if (this.storage.hasUnsaved(name)) {
      throw new Error(`Не удалось сохранить документ ${name}`);
    }
  }

  private async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    const hocuspocus = this.server?.hocuspocus;

    try {
      const names = new Set<string>([
        ...(hocuspocus?.documents.keys() ?? []),
        ...this.storage.unsavedNames(),
      ]);

      await this.flushNames(names);
    } catch (error) {
      this.logger.error(
        'Не удалось сохранить документы при остановке',
        error instanceof Error ? error.stack : error,
      );
    }

    await this.server?.destroy();
    this.server = undefined;
  }
}
