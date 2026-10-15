import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { TaskRequestsService } from './task-requests.service';
import { CreateTaskRequestDto, ReviewTaskRequestDto, UpdateTaskRequestDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('task-requests')
export class TaskRequestsController {
  constructor(private readonly requests: TaskRequestsService) {}

  // Team Members propose tasks. This is an ADDITIONAL path to task creation —
  // the PM's direct "create task" is untouched and needs no request.
  @Post()
  @Roles(Role.TEAM_MEMBER)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskRequestDto) {
    return this.requests.create(user, dto);
  }

  // Role-scoped in the service: member → own, lead → projects they lead,
  // PM/CEO → all (read-only oversight).
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.requests.list(user, status);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.findOne(user, id);
  }

  // Edit + resubmit after the lead asked for changes (requester only).
  @Patch(':id')
  @Roles(Role.TEAM_MEMBER)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTaskRequestDto) {
    return this.requests.update(user, id, dto);
  }

  // approve / deny / request_changes — the project's CURRENT lead only (checked
  // in the service). Deliberately not open to PM.
  @Post(':id/review')
  @Roles(Role.TEAM_LEAD)
  review(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReviewTaskRequestDto) {
    return this.requests.review(user, id, dto);
  }
}
