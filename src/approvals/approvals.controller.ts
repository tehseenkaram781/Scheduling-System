import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApprovalsService } from './approvals.service';
import { ReviewApprovalDto, SubmitApprovalDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  // Any role submits their own week for review (no @Roles gate — own week only).
  @Post('submit')
  submit(@CurrentUser() user: AuthUser, @Body() dto: SubmitApprovalDto) {
    return this.approvals.submit(user, dto.weekStart);
  }

  @Post('approve')
  @Roles(Role.PM)
  approve(@CurrentUser() user: AuthUser, @Body() dto: ReviewApprovalDto) {
    return this.approvals.approve(user, dto.userId, dto.weekStart);
  }

  @Post('revert')
  @Roles(Role.PM)
  revert(@CurrentUser() user: AuthUser, @Body() dto: ReviewApprovalDto) {
    return this.approvals.revert(user, dto.userId, dto.weekStart);
  }

  // PM inbox of submitted-but-unapproved timesheets.
  @Get('pending')
  @Roles(Role.PM)
  pending() {
    return this.approvals.pendingQueue();
  }

  @Get('status')
  status(
    @CurrentUser() user: AuthUser,
    @Query('weekStart') weekStart: string,
    @Query('userId') userId?: string,
  ) {
    return this.approvals.status(user, userId, weekStart);
  }
}
