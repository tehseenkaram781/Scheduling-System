import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { TimeEntriesService } from './time-entries.service';
import { CreateTimeEntryDto, UpdateTimeEntryDto, TimerStartDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';
import { resolveRange } from '../common/range.util';

@Controller('time-entries')
export class TimeEntriesController {
  constructor(private readonly entries: TimeEntriesService) {}

  // Every role logs time for themselves (validation of the target is per-role
  // in the service). No @Roles gate → any authenticated user, own entries only.
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTimeEntryDto) {
    return this.entries.create(user, dto);
  }

  // Fetch a user's week grid. Omit userId to read your own; viewing others is
  // gated by the "Reviewing" rules in the service layer.
  @Get('week')
  getByWeek(
    @CurrentUser() user: AuthUser,
    @Query('weekStart') weekStart: string,
    @Query('userId') userId?: string,
  ) {
    return this.entries.getByWeek(user, userId, weekStart);
  }

  // Calendar view: entries grouped by day over a range (same visibility rules).
  @Get('calendar')
  getCalendar(
    @CurrentUser() user: AuthUser,
    @Query('range') range?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('userId') userId?: string,
  ) {
    return this.entries.getCalendar(user, userId, resolveRange(range, startDate, endDate));
  }

  // Personal history: the caller's own lifetime activity log, grouped
  // Project → Subtask with a per-status hour breakdown. Own data only — no userId.
  @Get('history')
  getHistory(
    @CurrentUser() user: AuthUser,
    @Query('range') range?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.entries.getHistory(user, range, startDate, endDate);
  }

  // Deep search over already-visible hours (see deepSearch for the scope rules).
  // No @Roles → open to all authenticated users; scoping happens in the service.
  @Get('deep-search')
  deepSearch(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('scope') scope?: string,
    @Query('range') range?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
  ) {
    return this.entries.deepSearch(user, q ?? '', scope, range, startDate, endDate);
  }

  @Post('timer/start')
  startTimer(@CurrentUser() user: AuthUser, @Body() dto: TimerStartDto) {
    return this.entries.startTimer(user, dto);
  }

  @Post('timer/stop')
  stopTimer(@CurrentUser() user: AuthUser) {
    return this.entries.stopTimer(user);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTimeEntryDto) {
    return this.entries.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.entries.remove(user, id);
  }
}
