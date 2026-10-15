import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateTeamDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  // A team may be created leaderless and have a lead assigned later.
  @IsOptional()
  @IsUUID()
  teamLeadId?: string;
}

export class RenameTeamDto {
  // Name-only edit. Same constraints as creation (non-empty). No uniqueness
  // constraint exists on team name, so none is enforced here either (mirrors create).
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class SetTeamLeadDto {
  // Nullable-by-omission: pass a lead to (re)assign; omit to leave leaderless.
  @IsOptional()
  @IsUUID()
  teamLeadId?: string;
}

export class AddMemberDto {
  @IsUUID()
  userId: string;
}
