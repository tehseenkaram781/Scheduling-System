import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { TimesheetRowsService } from './timesheet-rows.service';
import { AddRowsDto, CopyWeekDto, PruneWeekDto } from './dto';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

// The row list is always the caller's own, scoped to one week. No @Roles gate —
// every role keeps a personal timesheet; per-target visibility is enforced in the
// service.
@Controller('timesheet-rows')
export class TimesheetRowsController {
  constructor(private readonly rows: TimesheetRowsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('weekStart') weekStart: string) {
    return this.rows.list(user, weekStart);
  }

  @Post()
  add(@CurrentUser() user: AuthUser, @Body() dto: AddRowsDto) {
    return this.rows.add(user, dto.picks, dto.weekStart);
  }

  // Copy the previous week's rows into this one — structure only or with hours.
  @Post('copy-previous')
  copyPrevious(@CurrentUser() user: AuthUser, @Body() dto: CopyWeekDto) {
    return this.rows.copyPreviousWeek(user, dto.weekStart, dto.mode);
  }

  // Save-draft cleanup: drop rows with no hours logged all week.
  @Post('prune-empty')
  prune(@CurrentUser() user: AuthUser, @Body() dto: PruneWeekDto) {
    return this.rows.pruneEmptyRows(user, dto.weekStart);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.rows.remove(user, id);
  }
}
