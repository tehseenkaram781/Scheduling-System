import { IsOptional, IsString, IsUUID } from 'class-validator';

export class RoleChangeDto {
  @IsUUID()
  userId: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
