import {
  Controller,
  Get,
  NotImplementedException,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';
import { resolveRange } from '../common/range.util';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  private range(range?: string, start?: string, end?: string) {
    return resolveRange(range, start, end);
  }

  // ----- CEO ---------------------------------------------------------------
  @Get('ceo/overview')
  @Roles(Role.CEO)
  ceoOverview(@Query('range') r?: string, @Query('start_date') s?: string, @Query('end_date') e?: string) {
    return this.analytics.ceoOverview(this.range(r, s, e));
  }

  @Get('ceo/resource-allocation')
  @Roles(Role.CEO)
  ceoResourceAllocation(@Query('range') r?: string, @Query('start_date') s?: string, @Query('end_date') e?: string) {
    return this.analytics.ceoResourceAllocation(this.range(r, s, e));
  }

  // ----- PM (CEO may also view) --------------------------------------------
  @Get('pm/projects-summary')
  @Roles(Role.PM, Role.CEO)
  pmProjectsSummary(@Query('range') r?: string, @Query('start_date') s?: string, @Query('end_date') e?: string) {
    return this.analytics.pmProjectsSummary(this.range(r, s, e));
  }

  @Get('pm/burn-down')
  @Roles(Role.PM, Role.CEO)
  pmBurnDown(@Query('project_id') projectId: string) {
    return this.analytics.pmBurnDown(projectId);
  }

  @Get('pm/task-status')
  @Roles(Role.PM, Role.CEO)
  pmTaskStatus() {
    return this.analytics.pmTaskStatus();
  }

  // ----- Team Lead ---------------------------------------------------------
  @Get('team-lead/team-distribution')
  @Roles(Role.TEAM_LEAD)
  teamDistribution(
    @CurrentUser() user: AuthUser,
    @Query('range') r?: string,
    @Query('start_date') s?: string,
    @Query('end_date') e?: string,
  ) {
    return this.analytics.teamLeadDistribution(user, this.range(r, s, e));
  }

  // ----- Me (any authenticated user, own data) -----------------------------
  @Get('me/time-distribution')
  myTimeDistribution(
    @CurrentUser() user: AuthUser,
    @Query('range') r?: string,
    @Query('start_date') s?: string,
    @Query('end_date') e?: string,
  ) {
    return this.analytics.myTimeDistribution(user, this.range(r, s, e));
  }

  // ----- Export (placeholder — implement CSV/PDF later) --------------------
  @Get('export')
  @Roles(Role.CEO)
  export() {
    throw new NotImplementedException('Export is not implemented yet');
  }
}
