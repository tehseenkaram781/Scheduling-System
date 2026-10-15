import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

const DECISIONS = ['approve', 'deny', 'reject'];

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Any authenticated user — always scoped to themselves.
  @Get()
  list(@CurrentUser('id') userId: string, @Query('unread') unread?: string) {
    return this.notifications.listForUser(userId, unread === 'true');
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.notifications.markRead(user, id);
  }

  // Inline approve/deny for actionable notifications (SUBMISSION / EDIT_REQUEST).
  @Post(':id/action')
  action(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { decision?: string; note?: string },
  ) {
    if (!body?.decision || !DECISIONS.includes(body.decision)) {
      throw new BadRequestException(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    return this.notifications.action(user, id, body.decision, body.note);
  }
}
