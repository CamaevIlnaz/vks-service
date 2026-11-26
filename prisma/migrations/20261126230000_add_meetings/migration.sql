-- Запланированные встречи. Не связаны с конференциями:
-- приглашение не даёт права подключиться к комнате.

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL,
    "roomId" UUID NOT NULL,
    "organizerId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_attendees" (
    "id" UUID NOT NULL,
    "meetingId" UUID NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meetings_roomId_idx" ON "meetings"("roomId");

-- CreateIndex
CREATE INDEX "meetings_organizerId_idx" ON "meetings"("organizerId");

-- CreateIndex
CREATE INDEX "meetings_startsAt_idx" ON "meetings"("startsAt");

-- CreateIndex
CREATE INDEX "meetings_endsAt_idx" ON "meetings"("endsAt");

-- CreateIndex
CREATE INDEX "meeting_attendees_userId_idx" ON "meeting_attendees"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_attendees_meetingId_userId_key" ON "meeting_attendees"("meetingId", "userId");

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
