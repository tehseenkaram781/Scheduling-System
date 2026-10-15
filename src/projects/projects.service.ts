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
import { notify, notifyRole } from '../common/notify.util';
import { CreateProjectDto, SetProjectLeadDto, UpdateProjectDto } from './dto';

// Current lead, surfaced on project listings for display.
const LEAD_SELECT = { teamLead: { select: { id: true, name: true } } } as const;

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actor: AuthUser, dto: CreateProjectDto) {
    const client = await this.prisma.client.findUnique({ where: { id: dto.clientId } });
    if (!client) throw new NotFoundException('Client not found');

    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          clientId: dto.clientId,
          name: dto.name,
          deadline: dto.deadline ? new Date(dto.deadline) : null,
          createdById: actor.id,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'PROJECT_CREATED',
        entityType: 'Project',
        entityId: project.id,
        newValue: project,
      });
      // Notification trigger: Project created → PM
      await notifyRole(tx, Role.PM, {
        type: 'ASSIGNMENT',
        message: `New project created: ${project.name}`,
        relatedEntityId: project.id,
      });
      return project;
    });
  }

  /** True if the user currently belongs to at least one live (non-deleted) team. */
  private async hasActiveTeam(userId: string): Promise<boolean> {
    const m = await this.prisma.teamMembership.findFirst({
      where: { userId, removedAt: null, team: { deletedAt: null } },
      select: { id: true },
    });
    return !!m;
  }

  /** Project ids a team lead / member can see. */
  private async assignedProjectIds(user: AuthUser): Promise<string[]> {
    if (user.role === Role.TEAM_LEAD) {
      // v6 — a lead sees the projects they currently lead directly.
      const rows = await this.prisma.project.findMany({
        where: { teamLeadId: user.id },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    // Team Member: visibility is gated on active team membership. No live team →
    // no project visibility, even if orphaned subtask assignments still exist.
    if (!(await this.hasActiveTeam(user.id))) return [];
    const rows = await this.prisma.subtaskTeamMemberAssignment.findMany({
      where: { teamMemberId: user.id, unassignedAt: null },
      select: { subtask: { select: { projectId: true } } },
    });
    return [...new Set(rows.map((r) => r.subtask.projectId))];
  }

  async list(user: AuthUser, includeArchived = false) {
    // Archived projects are hidden from default active-project lists but remain
    // queryable with ?include_archived=true (historical data / reports).
    const archiveFilter = includeArchived ? {} : { archivedAt: null };

    // CEO & PM: full operational visibility over all projects.
    if (user.role === Role.CEO || user.role === Role.PM) {
      return this.prisma.project.findMany({
        where: archiveFilter,
        include: { client: true, ...LEAD_SELECT },
        orderBy: { createdAt: 'desc' },
      });
    }
    // Team Lead / Member: only projects they are assigned into.
    const ids = await this.assignedProjectIds(user);
    return this.prisma.project.findMany({
      where: { id: { in: ids }, ...archiveFilter },
      include: { client: true, ...LEAD_SELECT },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Assign / change / clear a project's Team Lead (PM only). Mirrors Team.setLead:
   * updates the current-lead FK and keeps the ProjectTeamLeadAssignment history —
   * closes the previous open row and opens a new one, so "who led when" is preserved.
   */
  async setLead(actor: AuthUser, projectId: string, dto: SetProjectLeadDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    const newLeadId = dto.teamLeadId ?? null;
    if (newLeadId) {
      const lead = await this.prisma.user.findUnique({ where: { id: newLeadId } });
      if (!lead || lead.role !== Role.TEAM_LEAD || lead.deletedAt) {
        throw new BadRequestException('Target user is not a Team Lead');
      }
    }
    if (newLeadId === project.teamLeadId) {
      throw new BadRequestException('That lead is already assigned to this project');
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Close any currently-open assignment row.
      await tx.projectTeamLeadAssignment.updateMany({
        where: { projectId, unassignedAt: null },
        data: { unassignedAt: now },
      });
      // Open a new one if a lead was set (null = leaderless).
      if (newLeadId) {
        await tx.projectTeamLeadAssignment.create({
          data: { projectId, teamLeadId: newLeadId, assignedById: actor.id },
        });
      }
      const updated = await tx.project.update({
        where: { id: projectId },
        data: { teamLeadId: newLeadId },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'PROJECT_LEAD_CHANGED',
        entityType: 'Project',
        entityId: projectId,
        oldValue: { teamLeadId: project.teamLeadId },
        newValue: { teamLeadId: newLeadId },
      });

      // Cascade: every existing subtask member assignment under this project
      // belonged to the OLD lead's roster, not the new one (the "already
      // assigned to this project" guard above guarantees the lead actually
      // changed). The new lead starts blank and assigns members themselves —
      // mirrors the same cascade-unassign TeamsService.removeMember() already
      // does when a member leaves a team, scoped here by project instead.
      const stale = await tx.subtaskTeamMemberAssignment.findMany({
        where: { unassignedAt: null, subtask: { projectId } },
      });
      if (stale.length) {
        await tx.subtaskTeamMemberAssignment.updateMany({
          where: { id: { in: stale.map((s) => s.id) } },
          data: { unassignedAt: now },
        });
        for (const s of stale) {
          await writeAudit(tx, {
            actorId: actor.id,
            action: 'TEAM_MEMBER_UNASSIGNED',
            entityType: 'SubtaskTeamMemberAssignment',
            entityId: s.id,
            oldValue: s,
            newValue: { ...s, unassignedAt: now },
          });
        }
      }
      // Notification triggers: new lead gains the project; former lead loses it.
      if (newLeadId) {
        await notify(tx, {
          userId: newLeadId,
          type: 'ASSIGNMENT',
          message: `You were made lead of project: ${project.name}`,
          relatedEntityId: projectId,
        });
      }
      if (project.teamLeadId && project.teamLeadId !== newLeadId) {
        await notify(tx, {
          userId: project.teamLeadId,
          type: 'ASSIGNMENT',
          message: `You are no longer lead of project: ${project.name}`,
          relatedEntityId: projectId,
        });
      }
      return updated;
    });
  }

  /** Archive / unarchive (CEO or PM). Soft — nothing is deleted. */
  async setArchived(actor: AuthUser, id: string, archived: boolean) {
    const existing = await this.prisma.project.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Project not found');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: archived ? 'PROJECT_ARCHIVED' : 'PROJECT_UNARCHIVED',
        entityType: 'Project',
        entityId: id,
        oldValue: { archivedAt: existing.archivedAt },
        newValue: { archivedAt: updated.archivedAt },
      });
      return updated;
    });
  }

  async findOne(user: AuthUser, id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { client: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (user.role === Role.CEO || user.role === Role.PM) return project;

    const ids = await this.assignedProjectIds(user);
    if (!ids.includes(id)) throw new ForbiddenException('Not assigned to this project');
    return project;
  }

  async update(actor: AuthUser, id: string, dto: UpdateProjectDto) {
    const existing = await this.prisma.project.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Project not found');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          deadline: dto.deadline ? new Date(dto.deadline) : undefined,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'PROJECT_UPDATED',
        entityType: 'Project',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });
      return updated;
    });
  }

  async remove(actor: AuthUser, id: string) {
    const existing = await this.prisma.project.findUnique({
      where: { id },
      include: { subtasks: true },
    });
    if (!existing) throw new NotFoundException('Project not found');
    // Hard-delete is only for a truly-empty project. `subtasks` includes
    // soft-deleted rows (they still hold history), so any subtask blocks it.
    if (existing.subtasks.length > 0) {
      throw new ForbiddenException('Cannot delete a project that still has subtasks — archive it instead');
    }
    // A project with no subtasks can still have project-level ("general") time
    // logged against it. Deleting would orphan that timesheet history,
    // so block it and steer the CEO to archive instead.
    const loggedEntries = await this.prisma.timeEntry.count({ where: { projectId: id } });
    if (loggedEntries > 0) {
      throw new ForbiddenException('Cannot delete a project with logged time — archive it instead');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.project.delete({ where: { id } });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'PROJECT_DELETED',
        entityType: 'Project',
        entityId: id,
        oldValue: existing,
      });
      return { deleted: true };
    });
  }
}
