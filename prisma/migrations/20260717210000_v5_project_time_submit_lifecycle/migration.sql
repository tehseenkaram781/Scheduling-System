-- v5: project-level time entries, submit-locks-week Approval lifecycle, actionable notifications.

-- 1. TimeEntry.project_id (nullable, project-level entries)
ALTER TABLE "time_entries" ADD COLUMN "project_id" TEXT;
CREATE INDEX "time_entries_project_id_idx" ON "time_entries"("project_id");
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Notification actionable/resolved flags
ALTER TABLE "notifications" ADD COLUMN "actionable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications" ADD COLUMN "resolved" BOOLEAN NOT NULL DEFAULT false;

-- 3. ApprovalStatus enum: PENDING/APPROVED -> SUBMITTED/APPROVED/REVERTED.
--    Safe swap that remaps existing PENDING rows to SUBMITTED (they were awaiting review).
CREATE TYPE "ApprovalStatus_new" AS ENUM ('SUBMITTED', 'APPROVED', 'REVERTED');
ALTER TABLE "approvals" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "approvals" ALTER COLUMN "status" TYPE "ApprovalStatus_new"
  USING (CASE "status"::text WHEN 'PENDING' THEN 'SUBMITTED' ELSE "status"::text END::"ApprovalStatus_new");
DROP TYPE "ApprovalStatus";
ALTER TYPE "ApprovalStatus_new" RENAME TO "ApprovalStatus";
ALTER TABLE "approvals" ALTER COLUMN "status" SET DEFAULT 'SUBMITTED';
