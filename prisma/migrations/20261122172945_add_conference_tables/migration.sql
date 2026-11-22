-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('PERMANENT', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "RoomAccessType" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "ConferenceStatus" AS ENUM ('ACTIVE', 'EMPTY', 'ENDED');

-- CreateEnum
CREATE TYPE "ConferenceParticipantRole" AS ENUM ('HOST', 'MODERATOR', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Room" (
    "id" UUID NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "RoomType" NOT NULL,
    "accessType" "RoomAccessType" NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conference" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "status" "ConferenceStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emptyAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Conference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConferenceParticipant" (
    "id" UUID NOT NULL,
    "conferenceId" UUID NOT NULL,
    "userId" INTEGER,
    "guestId" UUID,
    "guestName" TEXT,
    "role" "ConferenceParticipantRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConferenceParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConferenceParticipantSession" (
    "id" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "deviceType" "DeviceType" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "ConferenceParticipantSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConferenceMessage" (
    "id" UUID NOT NULL,
    "conferenceId" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConferenceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Room_slug_key" ON "Room"("slug");

-- CreateIndex
CREATE INDEX "Room_ownerId_idx" ON "Room"("ownerId");

-- CreateIndex
CREATE INDEX "Conference_roomId_status_idx" ON "Conference"("roomId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Conference_one_unfinished_per_room" ON "Conference"("roomId") WHERE ("status" IN ('ACTIVE'::"ConferenceStatus", 'EMPTY'::"ConferenceStatus"));

-- CreateIndex
CREATE INDEX "ConferenceParticipant_conferenceId_idx" ON "ConferenceParticipant"("conferenceId");

-- CreateIndex
CREATE INDEX "ConferenceParticipant_userId_idx" ON "ConferenceParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ConferenceParticipant_conferenceId_userId_key" ON "ConferenceParticipant"("conferenceId", "userId") WHERE ("userId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ConferenceParticipant_conferenceId_guestId_key" ON "ConferenceParticipant"("conferenceId", "guestId") WHERE ("guestId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "ConferenceParticipantSession_participantId_leftAt_idx" ON "ConferenceParticipantSession"("participantId", "leftAt");

-- CreateIndex
CREATE INDEX "ConferenceMessage_conferenceId_createdAt_idx" ON "ConferenceMessage"("conferenceId", "createdAt");

-- CreateIndex
CREATE INDEX "ConferenceMessage_participantId_idx" ON "ConferenceMessage"("participantId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conference" ADD CONSTRAINT "Conference_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConferenceParticipant" ADD CONSTRAINT "ConferenceParticipant_conferenceId_fkey" FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConferenceParticipant" ADD CONSTRAINT "ConferenceParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConferenceParticipantSession" ADD CONSTRAINT "ConferenceParticipantSession_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "ConferenceParticipant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConferenceMessage" ADD CONSTRAINT "ConferenceMessage_conferenceId_fkey" FOREIGN KEY ("conferenceId") REFERENCES "Conference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConferenceMessage" ADD CONSTRAINT "ConferenceMessage_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "ConferenceParticipant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Участник — либо авторизованный пользователь, либо гость.
-- Prisma Schema не описывает CHECK, поэтому ограничение задано в миграции.
ALTER TABLE "ConferenceParticipant" ADD CONSTRAINT "ConferenceParticipant_identity_check" CHECK (
    ("userId" IS NOT NULL AND "guestId" IS NULL) OR
    ("userId" IS NULL AND "guestId" IS NOT NULL)
);
