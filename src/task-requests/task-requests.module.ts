import { Module } from '@nestjs/common';
import { TaskRequestsService } from './task-requests.service';
import { TaskRequestsController } from './task-requests.controller';

@Module({
  controllers: [TaskRequestsController],
  providers: [TaskRequestsService],
  // Exported so NotificationsModule can dispatch the inline inbox review.
  exports: [TaskRequestsService],
})
export class TaskRequestsModule {}
