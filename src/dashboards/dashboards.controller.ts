import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { DashboardsService } from './dashboards.service';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dashboards: DashboardsService) {}

  // --- PM ---
  @Get('pm/burndown')
  @Roles(Role.PM)
  pmBurndown() {
    return this.dashboards.pmBurndown();
  }

  @Get('pm/task-status')
  @Roles(Role.PM)
  pmTaskStatus() {
    return this.dashboards.pmTaskStatus();
  }

  // --- CEO ---
  @Get('ceo/resource-allocation')
  @Roles(Role.CEO)
  ceoResource() {
    return this.dashboards.ceoResourceAllocation();
  }

  // --- Team Lead ---
  @Get('team-lead/hour-distribution')
  @Roles(Role.TEAM_LEAD)
  leadHours(
    @CurrentUser() user: AuthUser,
    @Query('range') range?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.dashboards.teamLeadHourDistribution(user, range, startDate, endDate);
  }

  // --- Team aggregate (Team Member + Team Lead) ---
  // Aggregate-only by design: the payload has no member identities or per-member
  // figures, so a Team Member cannot derive who logged what from the response.
  @Get('team/hours')
  @Roles(Role.TEAM_MEMBER, Role.TEAM_LEAD)
  teamHours(
    @CurrentUser() user: AuthUser,
    @Query('range') range?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.dashboards.teamAggregateHours(user, range, startDate, endDate);
  }

  // Aggregate pending totals for "awaiting approval" tiles and empty states.
  // Any authenticated role — the numbers are totals, never per person.
  @Get('pending-hours')
  pendingHours(@CurrentUser() user: AuthUser) {
    return this.dashboards.pendingHours(user);
  }

  // --- Team Member ---
  @Get('team-member/hour-distribution')
  @Roles(Role.TEAM_MEMBER)
  memberHours(@CurrentUser() user: AuthUser) {
    return this.dashboards.memberHourDistribution(user);
  }
}
