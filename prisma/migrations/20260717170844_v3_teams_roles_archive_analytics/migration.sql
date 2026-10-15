-- CreateEnum
CREATE TYPE "SummaryPeriod" AS ENUM ('WEEK', 'MONTH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TEAM';
ALTER TYPE "NotificationType" ADD VALUE 'ROLE_CHANGE';
ALTER TYPE "NotificationType" ADD VALUE 'MEMBERSHIP';
ALTER TYPE "NotificationType" ADD VALUE 'BUDGET_ALERT';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "budget_alert_threshold_pct" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "last_alert_threshold_pct" INTEGER;

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "team_lead_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_memberships" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "team_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_change_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "old_role" "Role" NOT NULL,
    "new_role" "Role" NOT NULL,
    "changed_by" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_hours_summaries" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "period_type" "SummaryPeriod" NOT NULL,
    "total_hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pending_hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "approved_hours" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_hours_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_summaries" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "total_payroll" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teams_team_lead_id_idx" ON "teams"("team_lead_id");

-- CreateIndex
CREATE INDEX "team_memberships_team_id_idx" ON "team_memberships"("team_id");

-- CreateIndex
CREATE INDEX "team_memberships_user_id_idx" ON "team_memberships"("user_id");

-- CreateIndex
CREATE INDEX "role_change_logs_user_id_idx" ON "role_change_logs"("user_id");

-- CreateIndex
CREATE INDEX "project_hours_summaries_project_id_idx" ON "project_hours_summaries"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_hours_summaries_project_id_period_period_type_key" ON "project_hours_summaries"("project_id", "period", "period_type");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_summaries_period_key" ON "payroll_summaries"("period");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_team_lead_id_fkey" FOREIGN KEY ("team_lead_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_logs" ADD CONSTRAINT "role_change_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_change_logs" ADD CONSTRAINT "role_change_logs_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
