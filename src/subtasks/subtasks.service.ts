import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { round2 } from '../common/time.util';
import { CreateSubtaskDto, UpdateSubtaskDto } from './dto';

@Injectable()
export class SubtasksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actor: AuthUser, dto: CreateSubtaskDto) {
    const project = await this.prisma.project.findUnique({ where: { id: dto.projectId } });
    if (!project) throw new NotFoundException('Project not found');

    return this.prisma.$transaction(async (tx) => {
      const subtask = await tx.subtask.create({
        data: {
          projectId: dto.projectId,
          name: dto.name,
          deadline: dto.deadline ? new Date(dto.deadline) : null,
          estimatedHours: new Prisma.Decimal(dto.estimatedHours),
          createdById: actor.id,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'SUBTASK_CREATED',
        entityType: 'Subtask',
        entityId: subtask.id,
        newValue: subtask,
      });
      return subtask;
    });
  }

  /**
   * Does this team lead currently lead the subtask's PROJECT? (v6 — lead is now
   * assigned once at the project level and owns every subtask under it.)
   */
  async leadOwnsSubtask(teamLeadId: string, subtaskId: string): Promise<boolean> {
    const s = await this.prisma.subtask.findUnique({
      where: { id: subtaskId },
      select: { project: { select: { teamLeadId: true } } },
    });
    return !!s && s.project.teamLeadId === teamLeadId;
  }

  /** True if the user currently belongs to at least one live (non-deleted) team. */
  private async hasActiveTeam(userId: string): Promise<boolean> {
    const m = await this.prisma.teamMembership.findFirst({
      where: { userId, removedAt: null, team: { deletedAt: null } },
      select: { id: true },
    });
    return !!m;
  }

  /**
   * Does this member currently hold an active assignment on the subtask?
   * Gated on active team membership — a member with no live team has no
   * legitimate subtask visibility even if an orphaned assignment row remains.
   */
  async memberOnSubtask(teamMemberId: string, subtaskId: string): Promise<boolean> {
    if (!(await this.hasActiveTeam(teamMemberId))) return false;
    const a = await this.prisma.subtaskTeamMemberAssignment.findFirst({
      where: { subtaskId, teamMemberId, unassignedAt: null },
    });
    return !!a;
  }

  /** Enforces VIEW_OPERATIONAL_SUBTASK_DETAIL row-level rules and returns the subtask. */
  async assertCanView(user: AuthUser, subtaskId: string) {
    const subtask = await this.prisma.subtask.findUnique({
      where: { id: subtaskId },
      include: { project: { include: { client: true } } },
    });
    if (!subtask) throw new NotFoundException('Subtask not found');

    if (user.role === Role.CEO || user.role === Role.PM) return subtask;
    if (user.role === Role.TEAM_LEAD && (await this.leadOwnsSubtask(user.id, subtaskId))) {
      return subtask;
    }
    if (user.role === Role.TEAM_MEMBER && (await this.memberOnSubtask(user.id, subtaskId))) {
      return subtask;
    }
    throw new ForbiddenException('Not permitted to view this subtask');
  }

  async findOne(user: AuthUser, id: string) {
    return this.assertCanView(user, id);
  }

  async list(user: AuthUser, projectId?: string) {
    // Deleted subtasks are hidden from every default list / picker.
    const base: Prisma.SubtaskWhereInput = { deletedAt: null, ...(projectId ? { projectId } : {}) };

    // Include the parent project's current lead so the UI can display it read-only.
    const includeProjectLead = {
      project: { include: { teamLead: { select: { id: true, name: true } } } },
    } as const;

    if (user.role === Role.CEO || user.role === Role.PM) {
      return this.prisma.subtask.findMany({
        where: base,
        include: includeProjectLead,
        orderBy: { createdAt: 'desc' },
      });
    }
    if (user.role === Role.TEAM_LEAD) {
      // A lead's subtasks are every subtask under a project they currently lead.
      return this.prisma.subtask.findMany({
        where: { ...base, project: { teamLeadId: user.id } },
        include: includeProjectLead,
        orderBy: { createdAt: 'desc' },
      });
    }
    // TEAM_MEMBER — gated on active team membership; no live team → no subtasks.
    if (!(await this.hasActiveTeam(user.id))) return [];
    return this.prisma.subtask.findMany({
      where: {
        ...base,
        teamMemberAssignments: { some: { teamMemberId: user.id, unassignedAt: null } },
      },
      include: includeProjectLead,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateSubtaskDto) {
    const existing = await this.prisma.subtask.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Subtask not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subtask.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          deadline: dto.deadline ? new Date(dto.deadline) : undefined,
          estimatedHours:
            dto.estimatedHours != null ? new Prisma.Decimal(dto.estimatedHours) : undefined,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'SUBTASK_UPDATED',
        entityType: 'Subtask',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });
      return updated;
    });
  }

  /** Delete-impact summary for the confirmation dialog: logged hours + people. */
  async usage(id: string) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id } });
    if (!subtask) throw new NotFoundException('Subtask not found');
    const [agg, people] = await Promise.all([
      this.prisma.timeEntry.aggregate({ where: { subtaskId: id }, _sum: { hours: true }, _count: true }),
      this.prisma.timeEntry.findMany({ where: { subtaskId: id }, select: { userId: true }, distinct: ['userId'] }),
    ]);
    return { hours: round2(Number(agg._sum.hours ?? 0)), entries: agg._count, people: people.length };
  }

  /**
   * PM soft-delete. Sets deletedAt and cascades unassignedAt onto active member
   * assignments so it stops appearing as loggable/assignable. Existing TimeEntries
   * are untouched — they keep rendering in history, reports and audit.
   */
  async remove(actor: AuthUser, id: string) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id } });
    if (!subtask) throw new NotFoundException('Subtask not found');
    if (subtask.deletedAt) throw new BadRequestException('Subtask is already deleted');

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const deleted = await tx.subtask.update({ where: { id }, data: { deletedAt: now } });
      await tx.subtaskTeamMemberAssignment.updateMany({
        where: { subtaskId: id, unassignedAt: null },
        data: { unassignedAt: now },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'SUBTASK_DELETED',
        entityType: 'Subtask',
        entityId: id,
        oldValue: subtask,
        newValue: deleted,
      });
      return { deleted: true };
    });
  }
}
