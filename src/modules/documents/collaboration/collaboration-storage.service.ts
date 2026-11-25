import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import type { onStoreDocumentPayload } from '@hocuspocus/server';
import * as Y from 'yjs';
import { parseDocumentName } from './document-name.js';
import { visibleState, toBytes } from './yjs-state.js';

/**
 * В процессе один писатель на документ: Hocuspocus держит saveMutex,
 * а состояние кодируется в момент записи, а не в момент изменения.
 * Горизонтальная гонка не рассматривается — сервер один.
 * Пока документ в памяти, он новее строки в PostgreSQL, поэтому запись
 * всегда идёт из памяти в базу под блокировкой строки.
 */
@Injectable()
export class CollaborationStorageService {
  private readonly logger = new Logger(CollaborationStorageService.name);
  private readonly baseline = new Map<string, string>();
  private readonly revision = new Map<string, number>();
  private readonly savedRevision = new Map<string, number>();
  private readonly pendingConferences = new Map<string, Set<string>>();

  constructor(private readonly prisma: PrismaService) {}

  rememberBaseline(documentName: string, document: Y.Doc): void {
    this.baseline.set(documentName, visibleState(document));
  }

  forget(documentName: string): void {
    this.baseline.delete(documentName);
  }

  /** Учитывает только изменение общих типов. Awareness сюда не приходит. */
  noteContentChange(
    documentName: string,
    document: Y.Doc,
    conferenceId: string,
  ): void {
    const next = visibleState(document);
    const previous = this.baseline.get(documentName);

    this.baseline.set(documentName, next);

    if (previous === next) {
      return;
    }

    this.revision.set(documentName, (this.revision.get(documentName) ?? 0) + 1);

    const conferences =
      this.pendingConferences.get(documentName) ?? new Set<string>();

    conferences.add(conferenceId);
    this.pendingConferences.set(documentName, conferences);
  }

  hasUnsaved(documentName: string): boolean {
    return (
      (this.revision.get(documentName) ?? 0) !==
      (this.savedRevision.get(documentName) ?? 0)
    );
  }

  namesPendingConference(conferenceId: string): string[] {
    const names: string[] = [];

    for (const [name, conferences] of this.pendingConferences) {
      if (conferences.has(conferenceId)) {
        names.push(name);
      }
    }

    return names;
  }

  unsavedNames(): string[] {
    return [...this.revision.keys()].filter((name) => this.hasUnsaved(name));
  }

  async fetch(documentName: string): Promise<Uint8Array | null> {
    const documentId = parseDocumentName(documentName);

    if (!documentId) {
      return null;
    }

    const document = await this.prisma.roomDocument.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { yjsState: true },
    });

    if (!document || document.yjsState.byteLength === 0) {
      return null;
    }

    return new Uint8Array(document.yjsState);
  }

  async store(data: onStoreDocumentPayload): Promise<void> {
    const documentId = parseDocumentName(data.documentName);

    if (!documentId) {
      return;
    }

    const revision = this.revision.get(data.documentName) ?? 0;
    const conferenceIds = [
      ...(this.pendingConferences.get(data.documentName) ?? []),
    ];
    const state = Y.encodeStateAsUpdate(data.document);

    try {
      await this.persist(documentId, state, conferenceIds);
    } catch (error) {
      this.logger.error(
        `Не удалось сохранить документ ${data.documentName}`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }

    const saved = this.savedRevision.get(data.documentName) ?? 0;

    if (revision >= saved) {
      this.savedRevision.set(data.documentName, revision);
    }

    if ((this.revision.get(data.documentName) ?? 0) === revision) {
      this.pendingConferences.delete(data.documentName);
    }
  }

  private async persist(
    documentId: string,
    state: Uint8Array,
    conferenceIds: string[],
  ): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "room_documents"
        WHERE "id" = ${documentId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE
      `;

      if (locked.length === 0) {
        return;
      }

      await tx.roomDocument.update({
        where: { id: documentId },
        data: { yjsState: toBytes(state) },
      });

      if (conferenceIds.length === 0) {
        return;
      }

      const idList = Prisma.join(
        conferenceIds.map((id) => Prisma.sql`${id}::uuid`),
      );

      await tx.$executeRaw`
        UPDATE "conference_documents" AS cd
        SET
          "firstEditedAt" = COALESCE(cd."firstEditedAt", ${now}),
          "lastEditedAt" = ${now}
        WHERE cd."documentId" = ${documentId}::uuid
          AND cd."conferenceId" IN (${idList})
          AND EXISTS (
            SELECT 1 FROM "Conference" AS c
            WHERE c."id" = cd."conferenceId"
              AND c."status" <> 'ENDED'::"ConferenceStatus"
          )
      `;
    });
  }
}
