-- PM soft-delete for subtasks: nullable timestamp, mirrors Teams/Projects.
-- Existing time entries / assignments keep referencing the row; it is only
-- hidden from pickers and default lists when set.
ALTER TABLE "subtasks" ADD COLUMN "deleted_at" TIMESTAMP(3);
