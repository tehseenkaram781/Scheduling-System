/*
  Warnings:

  - The values [PAID] on the enum `NotificationType` will be removed. If these variants are still used in the database, this will fail.
  - The values [ACCOUNTANT] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.
  - The values [PAID] on the enum `TimeEntryStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `billable_rate` on the `clients` table. All the data in the column will be lost.
  - You are about to drop the column `currency` on the `clients` table. All the data in the column will be lost.
  - You are about to drop the column `client_billable_rate_snapshot` on the `time_entries` table. All the data in the column will be lost.
  - You are about to drop the column `employee_pay_rate` on the `users` table. All the data in the column will be lost.
  - You are about to drop the `payroll_summaries` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('ASSIGNMENT', 'SUBMISSION', 'APPROVAL', 'EDIT_REQUEST', 'EDIT_RESOLVED', 'TEAM', 'ROLE_CHANGE', 'MEMBERSHIP', 'BUDGET_ALERT', 'ACCOUNT', 'TIMESHEET');
ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "NotificationType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'CEO', 'PM', 'TEAM_LEAD', 'TEAM_MEMBER');
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TABLE "role_change_logs" ALTER COLUMN "old_role" TYPE "Role_new" USING ("old_role"::text::"Role_new");
ALTER TABLE "role_change_logs" ALTER COLUMN "new_role" TYPE "Role_new" USING ("new_role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "TimeEntryStatus_new" AS ENUM ('PENDING', 'APPROVED');
ALTER TABLE "time_entries" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "time_entries" ALTER COLUMN "status" TYPE "TimeEntryStatus_new" USING ("status"::text::"TimeEntryStatus_new");
ALTER TYPE "TimeEntryStatus" RENAME TO "TimeEntryStatus_old";
ALTER TYPE "TimeEntryStatus_new" RENAME TO "TimeEntryStatus";
DROP TYPE "TimeEntryStatus_old";
ALTER TABLE "time_entries" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- DropForeignKey
ALTER TABLE "timesheet_rows" DROP CONSTRAINT "timesheet_rows_project_id_fkey";

-- DropForeignKey
ALTER TABLE "timesheet_rows" DROP CONSTRAINT "timesheet_rows_subtask_id_fkey";

-- AlterTable
ALTER TABLE "clients" DROP COLUMN "billable_rate",
DROP COLUMN "currency";

-- AlterTable
ALTER TABLE "time_entries" DROP COLUMN "client_billable_rate_snapshot";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "employee_pay_rate";

-- DropTable
DROP TABLE "payroll_summaries";

-- CreateIndex
CREATE INDEX "projects_team_lead_id_idx" ON "projects"("team_lead_id");

-- AddForeignKey
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_subtask_id_fkey" FOREIGN KEY ("subtask_id") REFERENCES "subtasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timesheet_rows" ADD CONSTRAINT "timesheet_rows_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
