-- v7 — persistent picked timesheet rows + inactivity auto-removal notification.

-- New informational notification type for auto-removed rows.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TIMESHEET';

-- The user's picked timesheet rows (subtask OR project-level general row).
CREATE TABLE "timesheet_rows" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subtask_id" TEXT,
    "project_id" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timesheet_rows_pkey" PRIMARY KEY ("id")
);

-- NULLs are distinct in Postgres, so a user may have many subtask rows
-- (project_id NULL) and many project rows (subtask_id NULL); these only block
-- picking the *same* target twice.
CREATE UNIQUE INDEX "timesheet_rows_user_id_subtask_id_key" ON "timesheet_rows"("user_id", "subtask_id");
CREATE UNIQUE INDEX "timesheet_rows_user_id_project_id_key" ON "timesheet_rows"("user_id", "project_id");
CREATE INDEX "timesheet_rows_user_id_idx" ON "timesheet_rows"("user_id");

ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_subtask_id_fkey" FOREIGN KEY ("subtask_id") REFERENCES "subtasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
