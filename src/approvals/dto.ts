import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class SubmitApprovalDto {
  @IsDateString()
  weekStart: string;
}

export class ReviewApprovalDto {
  @IsUUID()
  userId: string;

  @IsDateString()
  weekStart: string;
}

export class ApprovalStatusQuery {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsDateString()
  weekStart: string;
}
