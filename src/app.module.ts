import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './rbac/roles.guard';
import { ClientsModule } from './clients/clients.module';
import { ProjectsModule } from './projects/projects.module';
import { SubtasksModule } from './subtasks/subtasks.module';
import { AssignmentsModule } from './assignments/assignments.module';
import { TimeEntriesModule } from './time-entries/time-entries.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { EditRequestsModule } from './edit-requests/edit-requests.module';
import { TaskRequestsModule } from './task-requests/task-requests.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { UsersModule } from './users/users.module';
import { DashboardsModule } from './dashboards/dashboards.module';
import { TeamsModule } from './teams/teams.module';
import { RolesModule } from './roles/roles.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TimesheetRowsModule } from './timesheet-rows/timesheet-rows.module';
import { AlertsModule } from './alerts/alerts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Cron host for the scheduled jobs in AlertsModule. This is the first
    // scheduled work in the codebase — nothing else runs on a timer.
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    ClientsModule,
    ProjectsModule,
    SubtasksModule,
    AssignmentsModule,
    TimeEntriesModule,
    ApprovalsModule,
    EditRequestsModule,
    TaskRequestsModule,
    NotificationsModule,
    AuditModule,
    UsersModule,
    DashboardsModule,
    TeamsModule,
    RolesModule,
    AnalyticsModule,
    TimesheetRowsModule,
    AlertsModule,
  ],
  controllers: [AppController],
  providers: [
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
