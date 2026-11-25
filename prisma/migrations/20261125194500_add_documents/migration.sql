-- Документы комнаты и их использование на конференциях.
-- Содержимое хранится один раз в room_documents.yjsState.
-- conference_documents не копирует документ, а только фиксирует использование.

-- CreateTable
CREATE TABLE "room_documents" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "createdById" INTEGER,
    "title" TEXT NOT NULL,
    "yjsState" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "room_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conference_documents" (
    "id" UUID NOT NULL,
    "conferenceId" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "attachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstEditedAt" TIMESTAMP(3),
    "lastEditedAt" TIMESTAMP(3),

    CONSTRAINT "conference_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_documents_roomId_deletedAt_idx" ON "room_documents"("roomId", "deletedAt");

-- CreateIndex
CREATE INDEX "room_documents_roomId_updatedAt_idx" ON "room_documents"("roomId", "updatedAt");

-- CreateIndex
CREATE INDEX "room_documents_createdById_idx" ON "room_documents"("createdById");

-- CreateIndex
CREATE INDEX "conference_documents_documentId_idx" ON "conference_documents"("documentId");

-- CreateIndex
CREATE INDEX "conference_documents_conferenceId_firstEditedAt_idx" ON "conference_documents"("conferenceId", "firstEditedAt");

-- CreateIndex
CREATE UNIQUE INDEX "conference_documents_conferenceId_documentId_key" ON "conference_documents"("conferenceId", "documentId");

-- AddForeignKey
ALTER TABLE "room_documents" ADD CONSTRAINT "room_documents_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_documents" ADD CONSTRAINT "room_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_documents" ADD CONSTRAINT "conference_documents_conferenceId_fkey" FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conference_documents" ADD CONSTRAINT "conference_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "room_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
