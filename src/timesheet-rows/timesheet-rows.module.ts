import { Module } from '@nestjs/common';
import { TimesheetRowsService } from './timesheet-rows.service';
import { TimesheetRowsController } from './timesheet-rows.controller';
import { SubtasksModule } from '../subtasks/subtasks.module';

@Module({
  imports: [SubtasksModule],
  controllers: [TimesheetRowsController],
  providers: [TimesheetRowsService],
  exports: [TimesheetRowsService],
})
export class TimesheetRowsModule {}
