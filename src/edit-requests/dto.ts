import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  Max,
  IsString,
  IsUUID,
} from 'class-validator';
import { MAX_HOURS_PER_ENTRY } from '../time-entries/dto';

export class CreateEditRequestDto {
  @IsUUID()
  timeEntryId: string;

  // At least one proposed change should be supplied. Capped at the same per-cell
  // maximum as a direct edit, so approving a request can't exceed it either.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(MAX_HOURS_PER_ENTRY)
  proposedHours?: number;

  @IsOptional()
  @IsString()
  proposedNotes?: string;

  @IsOptional()
  @IsBoolean()
  proposedBillable?: boolean;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
