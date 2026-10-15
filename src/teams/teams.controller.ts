import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { Role } from '@prisma/client';
import { TeamsService } from './teams.service';
import { AddMemberDto, CreateTeamDto, RenameTeamDto, SetTeamLeadDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  // List is role-filtered in the service (CEO/PM/Admin: all, Lead: own, Member: own read-only).
  @Get()
  @Roles(Role.CEO, Role.PM, Role.TEAM_LEAD, Role.TEAM_MEMBER, Role.ADMIN)
  list(@CurrentUser() user: AuthUser) {
    return this.teams.list(user);
  }

  // PM manages teams day-to-day; Admin may bootstrap them (per RBAC table).
  @Post()
  @Roles(Role.PM, Role.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTeamDto) {
    return this.teams.create(user, dto);
  }

  // Name-only rename — PM only, same restriction as create/delete.
  @Patch(':id')
  @Roles(Role.PM)
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RenameTeamDto) {
    return this.teams.rename(user, id, dto);
  }

  @Delete(':id')
  @Roles(Role.PM)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.teams.softDelete(user, id);
  }

  // Assign / change / clear the team's lead — PM only.
  @Put(':id/lead')
  @Roles(Role.PM)
  setLead(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetTeamLeadDto) {
    return this.teams.setLead(user, id, dto);
  }

  // Membership management — Team Lead on their own team, PM on any team (both
  // scoped in the service). PM access is required by exclusive membership: a
  // member can only join a new team after being removed from their current one,
  // so a team left leaderless would otherwise trap its members permanently.
  @Post(':id/members')
  @Roles(Role.PM, Role.TEAM_LEAD)
  addMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.teams.addMember(user, id, dto);
  }

  @Delete(':id/members/:userId')
  @Roles(Role.PM, Role.TEAM_LEAD)
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.teams.removeMember(user, id, userId);
  }
}
