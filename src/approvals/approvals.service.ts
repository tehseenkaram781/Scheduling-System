import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalStatus, Role, TimeEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify, notifyRole } from '../common/notify.util';
import { weekStartOf, endOfWeek, weekRangeLabel } from '../common/time.util';
import { recomputeProjectSummaries } from '../common/summary.util';

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Any role submits their own week for review --------------------------
  // Creating the Approval row (status SUBMITTED) immediately LOCKS the week.
  async submit(actor: AuthUser, weekStart: string) {
    const ws = weekStartOf(new Date(weekStart));

    const count = await this.prisma.timeEntry.count({
      where: { userId: actor.id, date: { gte: ws, lt: endOfWeek(ws) } },
    });
    if (count === 0) throw new BadRequestException('No time entries to submit for this week');

    const existing = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId: actor.id, weekStartDate: ws } },
    });
    // Blocked only if already locked (submitted or approved). Draft (no row) or
    // REVERTED may be (re)submitted.
    if (
      existing?.status === ApprovalStatus.SUBMITTED ||
      existing?.status === ApprovalStatus.APPROVED
    ) {
      throw new BadRequestException('This week is already submitted for review');
    }

    return this.prisma.$transaction(async (tx) => {
      const approval = await tx.approval.upsert({
        where: { userId_weekStartDate: { userId: actor.id, weekStartDate: ws } },
        update: {
          status: ApprovalStatus.SUBMITTED,
          approvedById: null,
          approvedAt: null,
          revertedAt: null,
        },
        create: { userId: actor.id, weekStartDate: ws, status: ApprovalStatus.SUBMITTED },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIMESHEET_SUBMITTED',
        entityType: 'Approval',
        entityId: approval.id,
        newValue: approval,
      });
      // Notification trigger: Timesheet submitted → PM (actionable — inline approve).
      await notifyRole(tx, Role.PM, {
        type: 'SUBMISSION',
        message: `${actor.name} submitted a timesheet for week of ${weekRangeLabel(ws)}`,
        relatedEntityId: approval.id,
        actionable: true,
      });
      return approval;
    });
  }

  // --- PM approves a member's week -----------------------------------------
  async approve(actor: AuthUser, userId: string, weekStart: string) {
    const ws = weekStartOf(new Date(weekStart));
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId, weekStartDate: ws } },
    });
    if (!approval) throw new NotFoundException('No submitted timesheet for that user/week');
    if (approval.status !== ApprovalStatus.SUBMITTED) {
      throw new BadRequestException(
        approval.status === ApprovalStatus.APPROVED
          ? 'Already approved'
          : 'Timesheet must be submitted before it can be approved',
      );
    }

    const entries = await this.prisma.timeEntry.findMany({
      where: { userId, date: { gte: ws, lt: endOfWeek(ws) }, status: TimeEntryStatus.PENDING },
      select: { id: true, projectId: true, subtask: { select: { projectId: true } } },
    });

    return this.prisma.$transaction(async (tx) => {
      const updatedApproval = await tx.approval.update({
        where: { id: approval.id },
        data: {
          status: ApprovalStatus.APPROVED,
          approvedById: actor.id,
          approvedAt: new Date(),
          revertedAt: null,
        },
      });

      await tx.timeEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { status: TimeEntryStatus.APPROVED },
      });

      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIMESHEET_APPROVED',
        entityType: 'Approval',
        entityId: approval.id,
        oldValue: approval,
        newValue: updatedApproval,
      });
      // Notification trigger: Approved → the timesheet owner.
      await notify(tx, {
        userId,
        type: 'APPROVAL',
        message: `Your timesheet for week of ${weekRangeLabel(ws)} was approved`,
        relatedEntityId: approval.id,
      });
      // Resolve the PM's SUBMISSION notifications for this week (hide their buttons).
      await tx.notification.updateMany({
        where: { type: 'SUBMISSION', relatedEntityId: approval.id, resolved: false },
        data: { resolved: true },
      });

      // Status → APPROVED: recompute affected project hours summaries.
      const projectIds = [
        ...new Set(
          entries
            .map((e) => e.subtask?.projectId ?? e.projectId)
            .filter((x): x is string => !!x),
        ),
      ];
      for (const pid of projectIds) {
        await recomputeProjectSummaries(tx, pid);
      }
      return { ...updatedApproval, approvedEntries: entries.length };
    });
  }

  // --- PM requests changes / reverts a week (SUBMITTED or APPROVED → REVERTED) -
  // Unlocks the week for editing; the owner must re-submit to move it back to
  // SUBMITTED. Any approved entries are re-opened to PENDING.
  async revert(actor: AuthUser, userId: string, weekStart: string) {
    const ws = weekStartOf(new Date(weekStart));
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId, weekStartDate: ws } },
    });
    if (!approval) throw new NotFoundException('No approval found');
    if (
      approval.status !== ApprovalStatus.SUBMITTED &&
      approval.status !== ApprovalStatus.APPROVED
    ) {
      throw new BadRequestException('Only submitted or approved timesheets can be reverted');
    }

    // Project ids affected (before we flip statuses) so summaries can be rebuilt.
    const affected = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: ws, lt: endOfWeek(ws) },
        status: TimeEntryStatus.APPROVED,
      },
      select: { subtaskId: true, projectId: true, subtask: { select: { projectId: true } } },
    });
    const projectIds = [
      ...new Set(
        affected.map((e) => e.subtask?.projectId ?? e.projectId).filter((x): x is string => !!x),
      ),
    ];

    return this.prisma.$transaction(async (tx) => {
      const reverted = await tx.approval.update({
        where: { id: approval.id },
        data: { status: ApprovalStatus.REVERTED, revertedAt: new Date() },
      });
      // Re-open APPROVED entries back to PENDING.
      await tx.timeEntry.updateMany({
        where: {
          userId,
          date: { gte: ws, lt: endOfWeek(ws) },
          status: TimeEntryStatus.APPROVED,
        },
        data: { status: TimeEntryStatus.PENDING },
      });
      for (const pid of projectIds) await recomputeProjectSummaries(tx, pid);
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIMESHEET_REVERTED',
        entityType: 'Approval',
        entityId: approval.id,
        oldValue: approval,
        newValue: reverted,
      });
      await notify(tx, {
        userId,
        type: 'APPROVAL',
        message: `Your timesheet for week of ${weekRangeLabel(ws)} was re-opened — please review and re-submit`,
        relatedEntityId: approval.id,
      });
      // Resolve any open SUBMISSION notifications for this week (PM acted).
      await tx.notification.updateMany({
        where: { type: 'SUBMISSION', relatedEntityId: approval.id, resolved: false },
        data: { resolved: true },
      });
      return reverted;
    });
  }

  async status(viewer: AuthUser, userId: string | undefined, weekStart: string) {
    const targetId = userId ?? viewer.id;
    if (
      targetId !== viewer.id &&
      viewer.role !== Role.CEO &&
      viewer.role !== Role.PM &&
      viewer.role !== Role.TEAM_LEAD
    ) {
      throw new ForbiddenException('Not permitted to view this approval');
    }
    const ws = weekStartOf(new Date(weekStart));
    return this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId: targetId, weekStartDate: ws } },
    });
  }

  /** PM inbox: all submitted (awaiting review) timesheets. */
  async pendingQueue() {
    return this.prisma.approval.findMany({
      where: { status: ApprovalStatus.SUBMITTED },
      // `role` feeds the Approvals screen's employee-type filter.
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { weekStartDate: 'desc' },
    });
  }
}
