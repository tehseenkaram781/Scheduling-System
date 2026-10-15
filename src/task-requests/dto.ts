import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTaskRequestDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  proposedName: string;

  // Optional: the member may not know the estimate; the lead can decide.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  proposedEstimatedHours?: number;

  // Required — the lead reviews on the strength of this.
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;
}

/** Edit + resubmit after CHANGES_REQUESTED. All fields optional (partial edit). */
export class UpdateTaskRequestDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  proposedName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  proposedEstimatedHours?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason?: string;
}

export const REVIEW_DECISIONS = ['approve', 'deny', 'request_changes'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export class ReviewTaskRequestDto {
  @IsIn(REVIEW_DECISIONS as unknown as string[])
  decision: ReviewDecision;

  // Required for deny / request_changes (checked in the service, since the rule
  // depends on `decision`); optional on approve.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
