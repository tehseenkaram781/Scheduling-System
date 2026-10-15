import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStatus,
  EditRequestStatus,
  Prisma,
  Role,
  TimeEntryStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEntriesService } from '../time-entries/time-entries.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify, notifyRole } from '../common/notify.util';
import { weekStartOf, endOfWeek, weekRangeLabel } from '../common/time.util';
import { CreateEditRequestDto } from './dto';

@Injectable()
export class EditRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entries: TimeEntriesService,
  ) {}

  // --- Owner of a locked entry requests a change ---------------------------
  async create(actor: AuthUser, dto: CreateEditRequestDto) {
    if (dto.proposedHours == null && dto.proposedNotes == null && dto.proposedBillable == null) {
      throw new BadRequestException('Provide at least one proposed change');
    }
    const entry = await this.prisma.timeEntry.findUnique({ where: { id: dto.timeEntryId } });
    if (!entry) throw new NotFoundException('Time entry not found');
    if (entry.userId !== actor.id) throw new ForbiddenException('Not your time entry');
    // Edit requests only exist for LOCKED entries (week Submitted or Approved) —
    // otherwise the owner edits directly.
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId: entry.userId, weekStartDate: weekStartOf(entry.date) } },
    });
    const locked =
      approval?.status === ApprovalStatus.SUBMITTED ||
      approval?.status === ApprovalStatus.APPROVED;
    if (!locked) {
      throw new BadRequestException('Entry is not locked — edit it directly instead');
    }

    const oldValue = {
      hours: Number(entry.hours),
      notes: entry.notes,
      billable: entry.billable,
    };
    const proposedValue = {
      // Stored exactly as proposed — no 15-minute snapping.
      hours: dto.proposedHours != null ? dto.proposedHours : oldValue.hours,
      notes: dto.proposedNotes ?? oldValue.notes,
      billable: dto.proposedBillable ?? oldValue.billable,
    };

    return this.prisma.$transaction(async (tx) => {
      const req = await tx.timeEntryEditRequest.create({
        data: {
          timeEntryId: entry.id,
          requestedById: actor.id,
          oldValue: oldValue as Prisma.InputJsonValue,
          proposedValue: proposedValue as Prisma.InputJsonValue,
          reason: dto.reason,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'EDIT_REQUEST_CREATED',
        entityType: 'TimeEntryEditRequest',
        entityId: req.id,
        newValue: req,
      });
      // Notification trigger: EditRequest submitted → PM (actionable — inline approve/deny).
      // Week resolved from the parent TimeEntry's date, prepended ahead of the
      // existing "Edit request from ...: reason" text (reason text unchanged).
      await notifyRole(tx, Role.PM, {
        type: 'EDIT_REQUEST',
        message: `Week of ${weekRangeLabel(weekStartOf(entry.date))} — Edit request from ${actor.name}: ${dto.reason}`,
        relatedEntityId: req.id,
        actionable: true,
      });
      return req;
    });
  }

  /** PM inbox of pending edit requests. */
  listPending() {
    return this.prisma.timeEntryEditRequest.findMany({
      where: { status: EditRequestStatus.PENDING },
      include: {
        timeEntry: true,
        requestedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { timeEntry: { date: 'asc' } },
    });
  }

  // --- PM approves: apply change + revert the week's Approval to PENDING ----
  async approve(actor: AuthUser, id: string) {
    const req = await this.prisma.timeEntryEditRequest.findUnique({
      where: { id },
      include: { timeEntry: true },
    });
    if (!req) throw new NotFoundException('Edit request not found');
    if (req.status !== EditRequestStatus.PENDING) {
      throw new BadRequestException('Edit request already resolved');
    }
    const proposed = req.proposedValue as { hours: number; notes: string | null; billable: boolean };
    const entry = req.timeEntry;
    const ws = weekStartOf(entry.date);

    // Approving an edit writes hours just like a direct update, so it is held to
    // the same 24h-day / 40h-row caps. Checked here rather than trusting the
    // value captured when the request was filed — the rest of the week may have
    // changed since, and the proposal could now breach a cap it once fitted.
    await this.entries.assertWithinCapsFor(
      entry.userId,
      entry.date,
      proposed.hours,
      { subtaskId: entry.subtaskId, projectId: entry.projectId },
      entry.id,
      Number(entry.hours),
    );

    return this.prisma.$transaction(async (tx) => {
      // 1. Apply the proposed change; the entry itself returns to PENDING.
      const updatedEntry = await tx.timeEntry.update({
        where: { id: entry.id },
        data: {
          hours: new Prisma.Decimal(proposed.hours),
          notes: proposed.notes,
          billable: proposed.billable,
          status: TimeEntryStatus.PENDING,
        },
      });

      // 2. Reopen the parent Approval → REVERTED (unlocked). The owner must
      //    re-submit the week, which moves it back to SUBMITTED.
      const approval = await tx.approval.findUnique({
        where: { userId_weekStartDate: { userId: entry.userId, weekStartDate: ws } },
      });
      if (
        approval &&
        (approval.status === ApprovalStatus.SUBMITTED ||
          approval.status === ApprovalStatus.APPROVED)
      ) {
        await tx.approval.update({
          where: { id: approval.id },
          data: { status: ApprovalStatus.REVERTED, revertedAt: new Date() },
        });
        // Re-open sibling APPROVED entries in the same week.
        await tx.timeEntry.updateMany({
          where: {
            userId: entry.userId,
            date: { gte: ws, lt: endOfWeek(ws) },
            status: TimeEntryStatus.APPROVED,
          },
          data: { status: TimeEntryStatus.PENDING },
        });
      }

      // 3. Resolve the request.
      const resolved = await tx.timeEntryEditRequest.update({
        where: { id },
        data: { status: EditRequestStatus.APPROVED, reviewedById: actor.id, reviewedAt: new Date() },
      });

      await writeAudit(tx, {
        actorId: actor.id,
        action: 'EDIT_REQUEST_APPROVED',
        entityType: 'TimeEntryEditRequest',
        entityId: id,
        oldValue: req,
        newValue: { resolved, updatedEntry },
      });
      // Notification trigger: EditRequest resolved → requester
      await notify(tx, {
        userId: req.requestedById,
        type: 'EDIT_RESOLVED',
        message: `Your edit request for week of ${weekRangeLabel(ws)} was approved — the week is re-opened, please re-submit`,
        relatedEntityId: id,
      });
      // Resolve the PM's EDIT_REQUEST notification (hide its buttons).
      await tx.notification.updateMany({
        where: { type: 'EDIT_REQUEST', relatedEntityId: id, resolved: false },
        data: { resolved: true },
      });
      return { resolved, updatedEntry };
    });
  }

  async deny(actor: AuthUser, id: string) {
    const req = await this.prisma.timeEntryEditRequest.findUnique({
      where: { id },
      include: { timeEntry: true },
    });
    if (!req) throw new NotFoundException('Edit request not found');
    if (req.status !== EditRequestStatus.PENDING) {
      throw new BadRequestException('Edit request already resolved');
    }
    return this.prisma.$transaction(async (tx) => {
      const resolved = await tx.timeEntryEditRequest.update({
        where: { id },
        data: { status: EditRequestStatus.DENIED, reviewedById: actor.id, reviewedAt: new Date() },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'EDIT_REQUEST_DENIED',
        entityType: 'TimeEntryEditRequest',
        entityId: id,
        oldValue: req,
        newValue: resolved,
      });
      const ws = weekStartOf(req.timeEntry.date);
      await notify(tx, {
        userId: req.requestedById,
        type: 'EDIT_RESOLVED',
        message: `Your edit request for week of ${weekRangeLabel(ws)} was denied`,
        relatedEntityId: id,
      });
      // Resolve the PM's EDIT_REQUEST notification (hide its buttons).
      await tx.notification.updateMany({
        where: { type: 'EDIT_REQUEST', relatedEntityId: id, resolved: false },
        data: { resolved: true },
      });
      return resolved;
    });
  }
}
