import { IsDateString, IsOptional, IsString, IsUUID, IsNotEmpty } from 'class-validator';

export class CreateProjectDto {
  @IsUUID()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}

// v6 — assign / change / clear a project's Team Lead. Omit teamLeadId to clear.
export class SetProjectLeadDto {
  @IsOptional()
  @IsUUID()
  teamLeadId?: string;
}
