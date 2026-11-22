-- AlterTable
ALTER TABLE "ConferenceParticipantSession" ADD COLUMN     "authSessionId" UUID;

-- CreateIndex
CREATE INDEX "ConferenceParticipantSession_authSessionId_leftAt_idx" ON "ConferenceParticipantSession"("authSessionId", "leftAt");

-- AddForeignKey
ALTER TABLE "ConferenceParticipantSession" ADD CONSTRAINT "ConferenceParticipantSession_authSessionId_fkey" FOREIGN KEY ("authSessionId") REFERENCES "AuthSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
