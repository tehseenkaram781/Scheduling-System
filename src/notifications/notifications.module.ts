import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { ApprovalsModule } from '../approvals/approvals.module';
import { EditRequestsModule } from '../edit-requests/edit-requests.module';
import { TaskRequestsModule } from '../task-requests/task-requests.module';

@Module({
  imports: [ApprovalsModule, EditRequestsModule, TaskRequestsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
