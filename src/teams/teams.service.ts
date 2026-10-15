import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify } from '../common/notify.util';
import { Db } from '../common/db.types';
import { AddMemberDto, CreateTeamDto, RenameTeamDto, SetTeamLeadDto } from './dto';

const MEMBER_INCLUDE = {
  teamLead: { select: { id: true, name: true, email: true } },
  memberships: {
    where: { removedAt: null },
    include: { user: { select: { id: true, name: true, email: true } } },
  },
} as const;

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertIsRole(userId: string, role: Role, label: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role !== role) throw new BadRequestException(`Target user is not a ${label}`);
    return u;
  }

  private async loadLiveTeam(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team || team.deletedAt) throw new NotFoundException('Team not found');
    return team;
  }

  /**
   * Membership management: a Team Lead may only touch the team they currently
   * lead; a PM may touch any team.
   *
   * The PM path is what keeps exclusive membership from deadlocking. Moving
   * someone between teams requires removing them from the first one, and a
   * lead-scoped-only rule would strand any member whose team has no lead (a PM
   * can clear a lead at any time via setLead) — nobody could remove them, so
   * they could never join another team.
   */
  private assertCanManageMembers(actor: AuthUser, team: { teamLeadId: string | null }) {
    if (actor.role === Role.PM) return;
    if (team.teamLeadId !== actor.id) {
      throw new ForbiddenException('You are not the lead of this team');
    }
  }

  // --- Create (PM) ---------------------------------------------------------
  async create(actor: AuthUser, dto: CreateTeamDto) {
    if (dto.teamLeadId) await this.assertIsRole(dto.teamLeadId, Role.TEAM_LEAD, 'Team Lead');
    return this.prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { name: dto.name, teamLeadId: dto.teamLeadId ?? null, createdById: actor.id },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_CREATED',
        entityType: 'Team',
        entityId: team.id,
        newValue: team,
      });
      // Notification trigger: Team created → new Team Lead
      if (team.teamLeadId) {
        await notify(tx, {
          userId: team.teamLeadId,
          type: 'TEAM',
          message: `You were made lead of team: ${team.name}`,
          relatedEntityId: team.id,
        });
      }
      return team;
    });
  }

  // --- Soft delete (PM) ----------------------------------------------------
  async softDelete(actor: AuthUser, teamId: string) {
    const team = await this.loadLiveTeam(teamId);
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.team.update({
        where: { id: teamId },
        data: { deletedAt: new Date() },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_DELETED',
        entityType: 'Team',
        entityId: teamId,
        oldValue: team,
        newValue: deleted,
      });
      // Notification trigger: Team deleted → former Team Lead.
      // Note: subtask assignments tied to the former lead are NOT auto-removed —
      // the PM must reassign them (per spec); they remain as historical assignments.
      if (team.teamLeadId) {
        await notify(tx, {
          userId: team.teamLeadId,
          type: 'TEAM',
          message: `Team deleted: ${team.name}`,
          relatedEntityId: teamId,
        });
      }
      return deleted;
    });
  }

  // --- Rename (PM) ---------------------------------------------------------
  // Name-only edit. Downstream references (member rows, notifications, future
  // audit entries) reflect the new name going forward; already-recorded AuditLog
  // rows keep the old name (history isn't rewritten).
  async rename(actor: AuthUser, teamId: string, dto: RenameTeamDto) {
    const team = await this.loadLiveTeam(teamId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: teamId },
        data: { name: dto.name },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_RENAMED',
        entityType: 'Team',
        entityId: teamId,
        oldValue: { name: team.name },
        newValue: { name: updated.name },
      });
      return updated;
    });
  }

  // --- Assign / change / clear lead (PM) -----------------------------------
  async setLead(actor: AuthUser, teamId: string, dto: SetTeamLeadDto) {
    const team = await this.loadLiveTeam(teamId);
    if (dto.teamLeadId) await this.assertIsRole(dto.teamLeadId, Role.TEAM_LEAD, 'Team Lead');
    const newLeadId = dto.teamLeadId ?? null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.team.update({
        where: { id: teamId },
        data: { teamLeadId: newLeadId },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TEAM_LEAD_CHANGED',
        entityType: 'Team',
        entityId: teamId,
        oldValue: { teamLeadId: team.teamLeadId },
        newValue: { teamLeadId: newLeadId },
      });
      if (newLeadId && newLeadId !== team.teamLeadId) {
        await notify(tx, {
          userId: newLeadId,
          type: 'TEAM',
          message: `You were made lead of team: ${team.name}`,
          relatedEntityId: teamId,
        });
      }
      if (team.teamLeadId && team.teamLeadId !== newLeadId) {
        await notify(tx, {
          userId: team.teamLeadId,
          type: 'TEAM',
          message: `You are no longer lead of team: ${team.name}`,
          relatedEntityId: teamId,
        });
      }
      return updated;
    });
  }

  // --- Add member (Team Lead on own team · PM on any) ----------------------
  async addMember(actor: AuthUser, teamId: string, dto: AddMemberDto) {
    const team = await this.loadLiveTeam(teamId);
    this.assertCanManageMembers(actor, team);
    await this.assertIsRole(dto.userId, Role.TEAM_MEMBER, 'Team Member');

    // A Team Member belongs to exactly one team at a time. Check across ALL live
    // teams, not just this one — otherwise the same person ends up on two rosters
    // and two leads can both assign them work. Remove them from their current team
    // first (which soft-removes the membership) before adding them here.
    const active = await this.prisma.teamMembership.findFirst({
      where: { userId: dto.userId, removedAt: null, team: { deletedAt: null } },
      include: { team: { select: { id: true, name: true } } },
    });
    if (active) {
      throw new BadRequestException(
        active.teamId === teamId
          ? 'User is already a member of this team'
          : `User is already on team "${active.team.name}" — remove them from it first`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.teamMembership.create({
        data: { teamId, userId: dto.userId, addedById: actor.id },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'MEMBER_ADDED_TO_TEAM',
        entityType: 'TeamMembership',
        entityId: membership.id,
        newValue: membership,
      });
      // Notification trigger: Added to Team → affected Team Member
      await notify(tx, {
        userId: dto.userId,
        type: 'MEMBERSHIP',
        message: `You were added to team: ${team.name}`,
        relatedEntityId: teamId,
      });
      return membership;
    });
  }

  // --- Remove member (Team Lead on own team · PM on any, soft-remove) ------
  async removeMember(actor: AuthUser, teamId: string, userId: string) {
    const team = await this.loadLiveTeam(teamId);
    this.assertCanManageMembers(actor, team);
    const active = await this.prisma.teamMembership.findFirst({
      where: { teamId, userId, removedAt: null },
    });
    if (!active) throw new NotFoundException('No active membership to remove');

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const removed = await tx.teamMembership.update({
        where: { id: active.id },
        data: { removedAt: now },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'MEMBER_REMOVED_FROM_TEAM',
        entityType: 'TeamMembership',
        entityId: active.id,
        oldValue: active,
        newValue: removed,
      });

      // Cascade: close the member's active subtask assignments under projects led
      // by THIS team's lead. Leaving them open would keep surfacing those projects
      // (sidebar, Table view, dropdowns) even though the member has left the team.
      // Scoped to this lead's projects so assignments from any OTHER team the member
      // is still on are untouched.
      if (team.teamLeadId) {
        const stale = await tx.subtaskTeamMemberAssignment.findMany({
          where: {
            teamMemberId: userId,
            unassignedAt: null,
            subtask: { project: { teamLeadId: team.teamLeadId } },
          },
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
      }

      // Notification trigger: Removed from Team → affected Team Member
      await notify(tx, {
        userId,
        type: 'MEMBERSHIP',
        message: `You were removed from team: ${team.name}`,
        relatedEntityId: teamId,
      });
      return removed;
    });
  }

  // --- List (role-filtered) ------------------------------------------------
  async list(actor: AuthUser) {
    const base = { deletedAt: null };
    // Admin sees the full roster (for the bootstrap Users & teams panel).
    if (actor.role === Role.CEO || actor.role === Role.PM || actor.role === Role.ADMIN) {
      return this.prisma.team.findMany({
        where: base,
        include: MEMBER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    if (actor.role === Role.TEAM_LEAD) {
      return this.prisma.team.findMany({
        where: { ...base, teamLeadId: actor.id },
        include: MEMBER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    if (actor.role === Role.TEAM_MEMBER) {
      return this.prisma.team.findMany({
        where: { ...base, memberships: { some: { userId: actor.id, removedAt: null } } },
        include: MEMBER_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    return []; // roles without a team view (fallthrough)
  }
}
