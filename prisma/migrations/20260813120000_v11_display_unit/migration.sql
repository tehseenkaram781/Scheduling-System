-- v11 — per-user duration display unit (Hours | Days).
--
-- DISPLAY ONLY. Nothing about how time is stored, entered or validated moves
-- with this: TimeEntry.hours stays hours, entry stays HH:MM, and the 0:00-9:00
-- per-cell rule plus the 24h/day and 40h/week caps keep operating on the same
-- underlying hour values. The preference is applied at render time (8h = 1 day),
-- so switching it can never change a stored figure or whether a cap is breached.
--
-- Defaulting to HOURS means every existing row keeps today's behaviour and no
-- backfill is required.
CREATE TYPE "DisplayUnit" AS ENUM ('HOURS', 'DAYS');

ALTER TABLE "users"
  ADD COLUMN "display_unit" "DisplayUnit" NOT NULL DEFAULT 'HOURS';
