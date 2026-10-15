import { Type } from 'class-transformer';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateSubtaskDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  estimatedHours: number;
}

export class UpdateSubtaskDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  estimatedHours?: number;
}
