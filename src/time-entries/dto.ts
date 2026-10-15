import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  Max,
  Min,
  IsString,
  IsUUID,
} from 'class-validator';
import { EntryType } from '@prisma/client';

// A single cell (one row × one day) can never hold more than this, for every
// entry type. Presented in the UI as a clock-style HH:MM duration (00:00–24:00).
//
// This is the weakest of three limits, all enforced server-side on every write:
//   1. this per-cell bound (24h),
//   2. DAY_HOURS_CAP  — the sum of ALL of a user's entries on one date (24h),
//   3. WEEK_HOURS_CAP — the weekly sum of any single grid row, of its parent
//      project's subtotal, and of the grand total (40h each).
// Distinct from the DAILY/WEEKLY_HOURS_CAP *warnings*, which only flag and never
// block. `hours` on the wire and in the database is unchanged (Decimal(6,2)).
export const MAX_HOURS_PER_ENTRY = 24;

/** A calendar day cannot hold more than 24 hours of logged time, in total. */
export const DAY_HOURS_CAP = 24;

/** Any row's weekly total — task, project subtotal, or grand total — caps here. */
export const WEEK_HOURS_CAP = 40;

export class CreateTimeEntryDto {
  // WORK entries reference EITHER a subtaskId (assignment-gated) OR a projectId
  // (project-level / general time). LEAVE_* entries reference neither. Mutual
  // exclusivity + role rules validated in the service.
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsDateString()
  date: string;

  // 0 is allowed: an explicit "0 hours" entry records that no work was done
  // (distinct from simply forgetting to log the day). Capped at 11 per cell.
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(MAX_HOURS_PER_ENTRY)
  hours: number;

  @IsEnum(EntryType)
  entryType: EntryType;

  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateTimeEntryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(MAX_HOURS_PER_ENTRY)
  hours?: number;

  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class TimerStartDto {
  // Either a subtask (assignment-gated) or a project (project-level time).
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
