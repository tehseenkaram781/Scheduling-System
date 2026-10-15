import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, TaskRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify, notifyRole } from '../common/notify.util';
import { Db } from '../common/db.types';
import {
  CreateTaskRequestDto,
  ReviewDecision,
  ReviewTaskRequestDto,
  UpdateTaskRequestDto,
} from './dto';

const REQUEST_INCLUDE = {
  project: { select: { id: true, name: true, teamLeadId: true } },
  requestedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

@Injectable()
export class TaskRequestsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Projects this member can see — the same rule the Projects list uses, so the
   * request form can never offer a project they have no visibility into.
   */
  private async visibleProjectIds(actor: AuthUser): Promise<string[] | null> {
    if (actor.role === Role.CEO || actor.role === Role.PM) return null; // all
    if (actor.role === Role.TEAM_LEAD) {
      const rows = await this.prisma.project.findMany({
        where: { teamLeadId: actor.id },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    const rows = await this.prisma.subtaskTeamMemberAssignment.findMany({
      where: { teamMemberId: actor.id, unassignedAt: null },
      select: { subtask: { select: { projectId: true } } },
    });
    return [...new Set(rows.map((r) => r.subtask.projectId))];
  }

  /**
   * Reviewing is bound to whoever leads the project RIGHT NOW, not whoever led
   * it when the request was filed — if leadership changes, pending requests
   * follow the new lead.
   */
  private assertCurrentLead(actor: AuthUser, project: { teamLeadId: string | null; name: string }) {
    if (actor.role !== Role.TEAM_LEAD || project.teamLeadId !== actor.id) {
      throw new ForbiddenException(`Only the current Team Lead of "${project.name}" can review this request`);
    }
  }

  // --- Create ---------------------------------------------------------------
  async create(actor: AuthUser, dto: CreateTaskRequestDto) {
    const project = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.archivedAt) throw new BadRequestException('That project is archived');

    const visible = await this.visibleProjectIds(actor);
    if (visible && !visible.includes(dto.projectId)) {
      throw new ForbiddenException('You do not have visibility into that project');
    }
    if (!project.teamLeadId) {
      throw new BadRequestException(
        'That project has no Team Lead yet, so there is nobody to review the request',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const req = await tx.taskRequest.create({
        data: {
          projectId: dto.projectId,
          requestedById: actor.id,
          proposedName: dto.proposedName,
          proposedEstimatedHours:
            dto.proposedEstimatedHours != null ? new Prisma.Decimal(dto.proposedEstimatedHours) : null,
          reason: dto.reason,
        },
        include: REQUEST_INCLUDE,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TASK_REQUEST_CREATED',
        entityType: 'TaskRequest',
        entityId: req.id,
        newValue: req,
      });
      await this.notifyLead(tx, req.id, project.teamLeadId!, actor.name, project.name, dto.proposedName);
      return req;
    });
  }

  /** Actionable notification to the project's current lead. */
  private notifyLead(
    tx: Db,
    requestId: string,
    leadId: string,
    requesterName: string,
    projectName: string,
    taskName: string,
  ) {
    return notify(tx, {
      userId: leadId,
      type: 'TASK_REQUEST',
      message: `${requesterName} requested a new task "${taskName}" under ${projectName}`,
      relatedEntityId: requestId,
      actionable: true,
    });
  }

  // --- Read -----------------------------------------------------------------
  /**
   * Member → own requests. Lead → requests on projects they currently lead.
   * PM/CEO → everything, read-only (they cannot review, but the PM is notified
   * on approval so being able to look them up is consistent).
   */
  async list(actor: AuthUser, status?: string) {
    const where: Prisma.TaskRequestWhereInput = {};
    if (status && Object.keys(TaskRequestStatus).includes(status)) {
      where.status = status as TaskRequestStatus;
    }
    if (actor.role === Role.TEAM_MEMBER) where.requestedById = actor.id;
    else if (actor.role === Role.TEAM_LEAD) where.project = { teamLeadId: actor.id };
    else if (actor.role !== Role.CEO && actor.role !== Role.PM) return [];

    return this.prisma.taskRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(actor: AuthUser, id: string) {
    const req = await this.prisma.taskRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!req) throw new NotFoundException('Task request not found');
    const isOwner = req.requestedById === actor.id;
    const isLead = req.project.teamLeadId === actor.id;
    const isOversight = actor.role === Role.PM || actor.role === Role.CEO;
    if (!isOwner && !isLead && !isOversight) throw new ForbiddenException('Not your task request');
    return req;
  }

  // --- Edit + resubmit ------------------------------------------------------
  /**
   * Only the requester, and only while the lead has sent it back. Resubmitting
   * reuses this row (status → PENDING) so the conversation and its history stay
   * on one record instead of forcing a fresh request.
   */
  async update(actor: AuthUser, id: string, dto: UpdateTaskRequestDto) {
    const existing = await this.prisma.taskRequest.findUnique({
      where: { id },
      include: { project: { select: { id: true, name: true, teamLeadId: true } } },
    });
    if (!existing) throw new NotFoundException('Task request not found');
    if (existing.requestedById !== actor.id) throw new ForbiddenException('Not your task request');
    if (existing.status !== TaskRequestStatus.CHANGES_REQUESTED) {
      throw new BadRequestException(
        existing.status === TaskRequestStatus.PENDING
          ? 'This request is already awaiting review'
          : `A ${existing.status.toLowerCase()} request cannot be edited — submit a new one`,
      );
    }
    if (!existing.project.teamLeadId) {
      throw new BadRequestException('That project has no Team Lead yet to review the request');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.taskRequest.update({
        where: { id },
        data: {
          proposedName: dto.proposedName ?? undefined,
          proposedEstimatedHours:
            dto.proposedEstimatedHours != null ? new Prisma.Decimal(dto.proposedEstimatedHours) : undefined,
          reason: dto.reason ?? undefined,
          // Back to the lead's queue; the previous review note stays as history.
          status: TaskRequestStatus.PENDING,
          reviewedAt: null,
        },
        include: REQUEST_INCLUDE,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TASK_REQUEST_RESUBMITTED',
        entityType: 'TaskRequest',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });
      // Any stale "changes requested" prompt in the member's own inbox is done.
      await tx.notification.updateMany({
        where: { relatedEntityId: id, actionable: true, resolved: false },
        data: { resolved: true },
      });
      await this.notifyLead(
        tx,
        id,
        existing.project.teamLeadId!,
        actor.name,
        existing.project.name,
        updated.proposedName,
      );
      return updated;
    });
  }

  // --- Review (current project lead only) -----------------------------------
  async review(actor: AuthUser, id: string, dto: ReviewTaskRequestDto) {
    const req = await this.prisma.taskRequest.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true, teamLeadId: true } },
        requestedBy: { select: { id: true, name: true } },
      },
    });
    if (!req) throw new NotFoundException('Task request not found');
    this.assertCurrentLead(actor, req.project);
    if (req.status !== TaskRequestStatus.PENDING) {
      throw new BadRequestException(`This request is already ${req.status.toLowerCase()}`);
    }
    const note = (dto.note ?? '').trim();
    if (dto.decision !== 'approve' && !note) {
      throw new BadRequestException(
        dto.decision === 'deny'
          ? 'A note explaining the denial is required'
          : 'A note describing what needs to change is required',
      );
    }

    const status: Record<ReviewDecision, TaskRequestStatus> = {
      approve: TaskRequestStatus.APPROVED,
      deny: TaskRequestStatus.DENIED,
      request_changes: TaskRequestStatus.CHANGES_REQUESTED,
    };

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      let subtaskId: string | null = null;

      if (dto.decision === 'approve') {
        subtaskId = await this.createApprovedTask(tx, actor, req);
      }

      const updated = await tx.taskRequest.update({
        where: { id },
        data: {
          status: status[dto.decision],
          reviewedById: actor.id,
          reviewNote: note || null,
          reviewedAt: now,
          createdSubtaskId: subtaskId,
        },
        include: REQUEST_INCLUDE,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: `TASK_REQUEST_${status[dto.decision]}`,
        entityType: 'TaskRequest',
        entityId: id,
        oldValue: req,
        newValue: updated,
      });

      // Close the lead's actionable prompt for this request.
      await tx.notification.updateMany({
        where: { relatedEntityId: id, actionable: true, resolved: false },
        data: { resolved: true, read: true },
      });

      // Tell the requester the outcome. On CHANGES_REQUESTED this is actionable
      // for them — it's the entry point to edit and resubmit.
      const outcome =
        dto.decision === 'approve'
          ? `Your task request "${req.proposedName}" was approved for ${req.project.name}`
          : dto.decision === 'deny'
            ? `Your task request "${req.proposedName}" for ${req.project.name} was denied — ${note}`
            : `Changes requested on your task request "${req.proposedName}" for ${req.project.name} — ${note}`;
      await notify(tx, {
        userId: req.requestedById,
        type: dto.decision === 'request_changes' ? 'TASK_REQUEST' : 'TASK_REQUEST_RESOLVED',
        message: outcome,
        relatedEntityId: id,
        actionable: dto.decision === 'request_changes',
      });

      // PM visibility only — informational, nothing for them to do.
      if (dto.decision === 'approve') {
        await notifyRole(tx, Role.PM, {
          type: 'TASK_REQUEST_RESOLVED',
          message: `Task "${req.proposedName}" was approved for ${req.project.name} by ${actor.name}`,
          relatedEntityId: subtaskId ?? id,
        });
      }
      return updated;
    });
  }

  /**
   * Approval side-effects, all inside the review transaction:
   *  1. create the real Subtask (identical to a PM-created one, plus provenance), and
   *  2. assign the requester to it.
   *
   * The assignment is still required, not optional polish: a Team Member may
   * only log time against a subtask they are assigned to (see
   * assertPickAllowed), so without it the requester could never add this task
   * to their own timesheet at all — the "+" picker would reject it. The
   * requester reached this project through an assignment under the same lead,
   * so this is one the lead could have made by hand anyway.
   *
   * What this step deliberately does NOT do: create a TimesheetRow. Approval
   * makes the task exist and be pickable — it doesn't pre-populate anyone's
   * table. The requester adds it to their own week via "+", the same as any
   * other existing task.
   */
  private async createApprovedTask(
    tx: Db,
    actor: AuthUser,
    req: { id: string; projectId: string; proposedName: string; proposedEstimatedHours: Prisma.Decimal | null; requestedById: string },
  ): Promise<string> {
    const subtask = await tx.subtask.create({
      data: {
        projectId: req.projectId,
        name: req.proposedName,
        estimatedHours: req.proposedEstimatedHours ?? new Prisma.Decimal(0),
        createdById: actor.id,
        requestedById: req.requestedById,
        approvedById: actor.id,
      },
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'SUBTASK_CREATED',
      entityType: 'Subtask',
      entityId: subtask.id,
      newValue: { ...subtask, viaTaskRequest: req.id },
    });

    const assignment = await tx.subtaskTeamMemberAssignment.create({
      data: { subtaskId: subtask.id, teamMemberId: req.requestedById, assignedById: actor.id },
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'TEAM_MEMBER_ASSIGNED',
      entityType: 'SubtaskTeamMemberAssignment',
      entityId: assignment.id,
      newValue: assignment,
    });

    return subtask.id;
  }
}
