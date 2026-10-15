import { Module } from '@nestjs/common';
import { EditRequestsService } from './edit-requests.service';
import { EditRequestsController } from './edit-requests.controller';
import { TimeEntriesModule } from '../time-entries/time-entries.module';

@Module({
  imports: [TimeEntriesModule],
  controllers: [EditRequestsController],
  providers: [EditRequestsService],
  exports: [EditRequestsService],
})
export class EditRequestsModule {}
