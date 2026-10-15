import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AssignmentsService } from './assignments.service';
import { AssignTeamMemberDto, ReassignTeamMemberDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  // Assign a Team Member to a subtask — Team Lead only, own subtasks only.
  @Post('team-members')
  @Roles(Role.TEAM_LEAD)
  assign(@CurrentUser() user: AuthUser, @Body() dto: AssignTeamMemberDto) {
    return this.assignments.assign(user, dto);
  }

  @Post('team-members/reassign')
  @Roles(Role.TEAM_LEAD)
  reassign(@CurrentUser() user: AuthUser, @Body() dto: ReassignTeamMemberDto) {
    return this.assignments.reassign(user, dto);
  }

  @Delete('team-members')
  @Roles(Role.TEAM_LEAD)
  unassign(
    @CurrentUser() user: AuthUser,
    @Query('subtaskId') subtaskId: string,
    @Query('teamMemberId') teamMemberId: string,
  ) {
    return this.assignments.unassign(user, subtaskId, teamMemberId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('subtaskId') subtaskId: string) {
    return this.assignments.listForSubtask(user, subtaskId);
  }
}
