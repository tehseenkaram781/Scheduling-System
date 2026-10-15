-- v6 — system ADMIN role + Admin-managed user lifecycle.
-- Hand-written (per the project's enum-migration-on-Windows convention): enum
-- value additions are done explicitly here and applied with `prisma migrate deploy`.

-- AlterEnum: system-level ADMIN role. Adding a value (not removing) is safe; the
-- new value is not referenced within this same transaction, so PG 12+ is fine.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN';

-- AlterEnum: informational account-lifecycle notification.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ACCOUNT';

-- AlterTable: Admin-managed user lifecycle columns.
ALTER TABLE "users" ADD COLUMN "created_by" TEXT;
ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "deactivated_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Existing (seeded) users already have known, working passwords — the forced-change
-- default only applies to accounts created by an Admin going forward.
UPDATE "users" SET "must_change_password" = false;

-- Self-relation: which Admin created the account (null on delete keeps history).
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
