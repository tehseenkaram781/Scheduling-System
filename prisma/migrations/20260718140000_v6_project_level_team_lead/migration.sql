-- v6 fix — move Team Lead from per-Subtask to per-Project.
-- Adds projects.team_lead_id (current lead) + project_team_lead_assignments (history),
-- promotes each project's existing (consistent) subtask-level lead, then drops the
-- old subtask_team_lead_assignments table. Applied via `prisma migrate deploy`.

-- 1. Current-lead FK on the project + history table.
ALTER TABLE "projects" ADD COLUMN "team_lead_id" TEXT;

CREATE TABLE "project_team_lead_assignments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "team_lead_id" TEXT NOT NULL,
  "assigned_by" TEXT NOT NULL,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassigned_at" TIMESTAMP(3),
  CONSTRAINT "project_team_lead_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "project_team_lead_assignments_project_id_idx" ON "project_team_lead_assignments"("project_id");
CREATE INDEX "project_team_lead_assignments_team_lead_id_idx" ON "project_team_lead_assignments"("team_lead_id");

-- 2. Promote each project's existing active subtask-level lead (consistent per project).
UPDATE "projects" p SET "team_lead_id" = sub.lead FROM (
  SELECT s."project_id" AS pid, MIN(a."team_lead_id") AS lead
  FROM "subtask_team_lead_assignments" a
  JOIN "subtasks" s ON s."id" = a."subtask_id"
  WHERE a."unassigned_at" IS NULL
  GROUP BY s."project_id"
) sub WHERE sub.pid = p."id";

-- 3. Backfill an open history row for each promoted current lead (assigned by the
--    project creator — good enough for the collapsed historical record).
INSERT INTO "project_team_lead_assignments" ("id","project_id","team_lead_id","assigned_by","assigned_at")
SELECT gen_random_uuid()::text, p."id", p."team_lead_id", p."created_by", now()
FROM "projects" p WHERE p."team_lead_id" IS NOT NULL;

-- 4. Foreign keys (Prisma-conventional names).
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_lead_id_fkey"
  FOREIGN KEY ("team_lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "project_team_lead_assignments" ADD CONSTRAINT "project_team_lead_assignments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_team_lead_assignments" ADD CONSTRAINT "project_team_lead_assignments_team_lead_id_fkey"
  FOREIGN KEY ("team_lead_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_team_lead_assignments" ADD CONSTRAINT "project_team_lead_assignments_assigned_by_fkey"
  FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Retire the per-subtask lead assignment table.
DROP TABLE "subtask_team_lead_assignments";
