import { IsUUID } from 'class-validator';

export class AssignTeamMemberDto {
  @IsUUID()
  subtaskId: string;

  @IsUUID()
  teamMemberId: string;
}

export class ReassignTeamMemberDto {
  @IsUUID()
  subtaskId: string;

  @IsUUID()
  fromTeamMemberId: string;

  @IsUUID()
  toTeamMemberId: string;
}
