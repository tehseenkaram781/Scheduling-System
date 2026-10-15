-- v8: make TimesheetRow week-scoped. A "picked row" now belongs to one specific
-- week rather than persisting across every week.

-- 1. Add the week column (nullable for backfill).
ALTER TABLE "timesheet_rows" ADD COLUMN "week_start_date" DATE;

-- 2. Backfill existing (persistent) picks onto the Monday of the week they were
--    added, so no data is lost — they simply become that week's rows.
--    date_trunc('week', ...) is Monday-based in Postgres.
UPDATE "timesheet_rows"
   SET "week_start_date" = (date_trunc('week', "added_at"))::date
 WHERE "week_start_date" IS NULL;

-- 3. Now enforce NOT NULL.
ALTER TABLE "timesheet_rows" ALTER COLUMN "week_start_date" SET NOT NULL;

-- 4. Swap the uniqueness/lookup indexes to be week-scoped.
DROP INDEX IF EXISTS "timesheet_rows_user_id_subtask_id_key";
DROP INDEX IF EXISTS "timesheet_rows_user_id_project_id_key";
DROP INDEX IF EXISTS "timesheet_rows_user_id_idx";

CREATE UNIQUE INDEX "timesheet_rows_user_id_subtask_id_week_start_date_key"
    ON "timesheet_rows" ("user_id", "subtask_id", "week_start_date");
CREATE UNIQUE INDEX "timesheet_rows_user_id_project_id_week_start_date_key"
    ON "timesheet_rows" ("user_id", "project_id", "week_start_date");
CREATE INDEX "timesheet_rows_user_id_week_start_date_idx"
    ON "timesheet_rows" ("user_id", "week_start_date");
