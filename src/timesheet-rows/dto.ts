import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsDateString, IsIn, IsOptional, IsUUID, ValidateNested } from 'class-validator';

/** One picked target: exactly one of subtaskId / projectId (validated in service). */
export class PickDto {
  @IsOptional()
  @IsUUID()
  subtaskId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}

/** Add one or more picks to a single week (the picker sends a multi-select). */
export class AddRowsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => PickDto)
  picks: PickDto[];

  // The week these rows belong to (any date in it; server snaps to Monday).
  @IsDateString()
  weekStart: string;
}

/** Copy last week's rows into `weekStart` — structure only, or with hours. */
export class CopyWeekDto {
  @IsDateString()
  weekStart: string;

  @IsIn(['tasks', 'hours'])
  mode: 'tasks' | 'hours';
}

/** Save-draft cleanup target week. */
export class PruneWeekDto {
  @IsDateString()
  weekStart: string;
}
