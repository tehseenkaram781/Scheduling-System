import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AlertsService } from './alerts.service';

/**
 * Scheduled background jobs. No controller — nothing here is triggered by a
 * request; ScheduleModule.forRoot() in AppModule drives it.
 */
@Module({
  imports: [PrismaModule],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
