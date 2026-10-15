import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify } from '../common/notify.util';
import { Db } from '../common/db.types';
import { AssignTeamMemberDto, ReassignTeamMemberDto } from './dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subtasks: SubtasksService,
  ) {}

  private async assertLeadOwns(actor: AuthUser, subtaskId: string) {
    // Team Lead may only assign within their OWN subtasks (row-level rule).
    if (!(await this.subtasks.leadOwnsSubtask(actor.id, subtaskId))) {
      throw new ForbiddenException('You are not the Team Lead for this subtask');
    }
  }

  private async assertIsMember(teamMemberId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: teamMemberId } });
    if (!u || u.role !== Role.TEAM_MEMBER) {
      throw new BadRequestException('Target user is not a Team Member');
    }
    return u;
  }

  /**
   * A Team Lead may only assign members who are actually on one of THEIR teams
   * (an active TeamMembership in a Team they lead) — not just any Team Member in
   * the system. A lead may own more than one Team (no uniqueness constraint stops
   * that), so this checks across all teams they lead, not a single one.
   */
  private async assertOnLeadsTeam(actor: AuthUser, teamMemberId: string) {
    const membership = await this.prisma.teamMembership.findFirst({
      where: {
        userId: teamMemberId,
        removedAt: null,
        team: { teamLeadId: actor.id, deletedAt: null },
      },
    });
    if (!membership) {
      throw new ForbiddenException('This Team Member is not on your team');
    }
  }

  /** Shared active-assignment creator used by assign + reassign. */
  private async doAssign(tx: Db, actor: AuthUser, subtaskId: string, teamMemberId: string, subtaskName: string) {
    const assignment = await tx.subtaskTeamMemberAssignment.create({
      data: { subtaskId, teamMemberId, assignedById: actor.id },
    });
    await writeAudit(tx, {
      actorId: actor.id,
      action: 'TEAM_MEMBER_ASSIGNED',
      entityType: 'SubtaskTeamMemberAssignment',
      entityId: assignment.id,
      newValue: assignment,
    });
    // Notification trigger: Team Member assigned → Team Member
    await notify(tx, {
      userId: teamMemberId,
      type: 'ASSIGNMENT',
      message: `You were assigned to subtask: ${subtaskName}`,
      relatedEntityId: subtaskId,
    });
    return assignment;
  }

  async assign(actor: AuthUser, dto: AssignTeamMemberDto) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id: dto.subtaskId } });
    if (!subtask) throw new NotFoundException('Subtask not found');
    if (subtask.deletedAt) throw new BadRequestException('This subtask has been deleted');
    await this.assertLeadOwns(actor, dto.subtaskId);
    await this.assertIsMember(dto.teamMemberId);
    await this.assertOnLeadsTeam(actor, dto.teamMemberId);

    const active = await this.prisma.subtaskTeamMemberAssignment.findFirst({
      where: { subtaskId: dto.subtaskId, teamMemberId: dto.teamMemberId, unassignedAt: null },
    });
    if (active) throw new BadRequestException('Team Member is already assigned to this subtask');

    return this.prisma.$transaction((tx) =>
      this.doAssign(tx, actor, dto.subtaskId, dto.teamMemberId, subtask.name),
    );
  }

  async unassign(actor: AuthUser, subtaskId: string, teamMemberId: string) {
    await this.assertLeadOwns(actor, subtaskId);
    const active = await this.prisma.subtaskTeamMemberAssignment.findFirst({
      where: { subtaskId, teamMemberId, unassignedAt: null },
    });
    if (!active) throw new NotFoundException('No active assignment to remove');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.subtaskTeamMemberAssignment.update({
        where: { id: active.id },
        data: { unassignedAt: new Date() },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_MEMBER_UNASSIGNED',
        entityType: 'SubtaskTeamMemberAssignment',
        entityId: active.id,
        oldValue: active,
        newValue: updated,
      });
      return updated;
    });
  }

  /**
   * Reassign preserves history: the old assignment is closed with unassignedAt
   * and a new one opened. Past TimeEntries are NOT touched — their assignment
   * context is reconstructable from assigned_at/unassigned_at windows.
   */
  async reassign(actor: AuthUser, dto: ReassignTeamMemberDto) {
    const subtask = await this.prisma.subtask.findUnique({ where: { id: dto.subtaskId } });
    if (!subtask) throw new NotFoundException('Subtask not found');
    await this.assertLeadOwns(actor, dto.subtaskId);
    await this.assertIsMember(dto.toTeamMemberId);
    await this.assertOnLeadsTeam(actor, dto.toTeamMemberId);

    const active = await this.prisma.subtaskTeamMemberAssignment.findFirst({
      where: { subtaskId: dto.subtaskId, teamMemberId: dto.fromTeamMemberId, unassignedAt: null },
    });
    if (!active) throw new NotFoundException('Source member has no active assignment here');

    return this.prisma.$transaction(async (tx) => {
      const closed = await tx.subtaskTeamMemberAssignment.update({
        where: { id: active.id },
        data: { unassignedAt: new Date() },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_MEMBER_UNASSIGNED',
        entityType: 'SubtaskTeamMemberAssignment',
        entityId: active.id,
        oldValue: active,
        newValue: closed,
      });
      const created = await this.doAssign(
        tx,
        actor,
        dto.subtaskId,
        dto.toTeamMemberId,
        subtask.name,
      );
      return { closed, created };
    });
  }

  /** Current active member assignments for a subtask (Team Lead view of own subtask). */
  async listForSubtask(actor: AuthUser, subtaskId: string) {
    await this.subtasks.assertCanView(actor, subtaskId);
    return this.prisma.subtaskTeamMemberAssignment.findMany({
      where: { subtaskId },
      include: { teamMember: { select: { id: true, name: true, email: true } } },
      orderBy: { assignedAt: 'desc' },
    });
  }
}
