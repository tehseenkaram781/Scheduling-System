-- v9: member-requested task creation, reviewed by the project's Team Lead.

-- New notification kinds: TASK_REQUEST is actionable (lead reviews inline),
-- TASK_REQUEST_RESOLVED is the informational outcome (requester + PMs).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TASK_REQUEST_RESOLVED';

DO $$ BEGIN
  CREATE TYPE "TaskRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CHANGES_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Provenance on the produced task: both NULL for a normal PM-created subtask,
-- so a member-requested one stays distinguishable in the audit trail.
ALTER TABLE "subtasks" ADD COLUMN IF NOT EXISTS "requested_by" TEXT;
ALTER TABLE "subtasks" ADD COLUMN IF NOT EXISTS "approved_by" TEXT;

DO $$ BEGIN
  ALTER TABLE "subtasks" ADD CONSTRAINT "subtasks_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "subtasks" ADD CONSTRAINT "subtasks_approved_by_fkey"
    FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "task_requests" (
  "id"                       TEXT NOT NULL,
  "project_id"               TEXT NOT NULL,
  "requested_by"             TEXT NOT NULL,
  "proposed_name"            TEXT NOT NULL,
  "proposed_estimated_hours" DECIMAL(10,2),
  "reason"                   TEXT NOT NULL,
  "status"                   "TaskRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewed_by"              TEXT,
  "review_note"              TEXT,
  "reviewed_at"              TIMESTAMP(3),
  "created_subtask_id"       TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "task_requests_project_id_status_idx" ON "task_requests"("project_id", "status");
CREATE INDEX IF NOT EXISTS "task_requests_requested_by_idx" ON "task_requests"("requested_by");

DO $$ BEGIN
  ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "task_requests" ADD CONSTRAINT "task_requests_created_subtask_id_fkey"
    FOREIGN KEY ("created_subtask_id") REFERENCES "subtasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
