/*
  Warnings:

  - The values [BUDGET_ALERT] on the enum `NotificationType` will be removed.
  - You are about to drop the column `total_budget` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `budget_alert_threshold_pct` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `last_alert_threshold_pct` on the `projects` table. All the data in the column will be lost.

  Budget tracking is removed along with payments: the overage-alert producer
  (budget.util.ts) was already deleted, so these columns and the BUDGET_ALERT
  notification type were inert. Existing BUDGET_ALERT rows are deleted first —
  the enum cast below would fail on them.
*/

-- Drop notifications that use the enum value being removed.
DELETE FROM "notifications" WHERE "type" = 'BUDGET_ALERT';

-- AlterEnum
BEGIN;
CREATE TYPE "NotificationType_new" AS ENUM ('ASSIGNMENT', 'SUBMISSION', 'APPROVAL', 'EDIT_REQUEST', 'EDIT_RESOLVED', 'TEAM', 'ROLE_CHANGE', 'MEMBERSHIP', 'ACCOUNT', 'TIMESHEET');
ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "NotificationType_new" USING ("type"::text::"NotificationType_new");
ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";
DROP TYPE "NotificationType_old";
COMMIT;

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "total_budget",
DROP COLUMN "budget_alert_threshold_pct",
DROP COLUMN "last_alert_threshold_pct";
