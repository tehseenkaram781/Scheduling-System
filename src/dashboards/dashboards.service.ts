import { Injectable } from '@nestjs/common';
import { Role, TimeEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { activityDateFilter, resolveActivityRange } from '../common/range.util';
import { APPROVED_ONLY, approvedOnly, pendingOnly } from '../common/status.util';
import { round2 } from '../common/time.util';

@Injectable()
export class DashboardsService {
  constructor(private readonly prisma: PrismaService) {}

  // ===== PM =================================================================

  /** Burn-down: estimated vs logged hours and days-to-deadline, per subtask. */
  async pmBurndown() {
    const subtasks = await this.prisma.subtask.findMany({
      include: {
        project: { select: { name: true } },
        timeEntries: { where: approvedOnly, select: { hours: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const now = Date.now();
    return subtasks.map((s) => {
      const hoursLogged = round2(s.timeEntries.reduce((sum, e) => sum + Number(e.hours), 0));
      const estimated = round2(Number(s.estimatedHours));
      return {
        subtaskId: s.id,
        subtask: s.name,
        project: s.project.name,
        estimatedHours: estimated,
        hoursLogged,
        remainingHours: round2(Math.max(estimated - hoursLogged, 0)),
        deadline: s.deadline,
        daysToDeadline: s.deadline
          ? Math.ceil((s.deadline.getTime() - now) / 86_400_000)
          : null,
      };
    });
  }

  /** Task-status breakdown: Unassigned / Pending / Approved with percentages. */
  async pmTaskStatus() {
    const subtasks = await this.prisma.subtask.findMany({
      include: {
        teamMemberAssignments: { where: { unassignedAt: null }, select: { id: true } },
        timeEntries: { select: { status: true } },
      },
    });

    let unassigned = 0;
    let pending = 0;
    let approved = 0;
    for (const s of subtasks) {
      if (s.teamMemberAssignments.length === 0) {
        unassigned++;
      } else if (
        s.timeEntries.length > 0 &&
        s.timeEntries.every((e) => APPROVED_ONLY.includes(e.status))
      ) {
        approved++;
      } else {
        pending++;
      }
    }
    const total = subtasks.length || 1;
    const pct = (n: number) => Math.round((n / total) * 1000) / 10;
    return {
      total: subtasks.length,
      counts: { unassigned, pending, approved },
      percentages: { unassigned: pct(unassigned), pending: pct(pending), approved: pct(approved) },
    };
  }

  // ===== CEO ================================================================

  /** Resource allocation: approved hours grouped by client → project. */
  async ceoResourceAllocation() {
    const entries = await this.prisma.timeEntry.findMany({
      where: { status: { in: APPROVED_ONLY }, subtaskId: { not: null } },
      include: {
        subtask: { include: { project: { include: { client: true } } } },
      },
    });
    const clients = new Map<string, { client: string; totalHours: number; projects: Map<string, number> }>();
    for (const e of entries) {
      const client = e.subtask!.project.client;
      const projName = e.subtask!.project.name;
      const bucket =
        clients.get(client.id) ?? { client: client.name, totalHours: 0, projects: new Map() };
      const h = Number(e.hours);
      bucket.totalHours += h;
      bucket.projects.set(projName, (bucket.projects.get(projName) ?? 0) + h);
      clients.set(client.id, bucket);
    }
    // Summing Decimal-backed floats drifts; hours are stored to 2dp, so the
    // sums are rounded back to 2dp before they leave the service.
    return [...clients.values()].map((b) => ({
      client: b.client,
      totalHours: round2(b.totalHours),
      projects: [...b.projects.entries()].map(([project, hours]) => ({ project, hours: round2(hours) })),
    }));
  }

  // ===== Team Lead ==========================================================

  /**
   * Team's hour distribution across the lead's assigned subtasks.
   *
   * Scoped on BOTH axes, and it has to be. The subtasks come from projects this
   * lead owns — but anyone can be assigned work on such a project, including
   * members of other teams and other Team Leads. Filtering only by project
   * therefore surfaced people the lead doesn't manage. The entries are
   * additionally restricted to the lead's own active team members (plus the
   * lead's own hours, which are theirs to see), so every figure here belongs to
   * someone this lead actually leads.
   */
  async teamLeadHourDistribution(lead: AuthUser, range?: string, startDate?: string, endDate?: string) {
    const memberIds = await this.teamMemberIdsFor(lead);
    // The lead's own logged hours on their projects stay visible to them.
    const visibleUserIds = [...new Set([...memberIds, lead.id])];
    const window = resolveActivityRange(range, startDate, endDate);
    const subtasks = await this.prisma.subtask.findMany({
      where: { project: { teamLeadId: lead.id } },
      include: {
        // Subtask names are only unique WITHIN a project — two projects can both
        // have a "UI build". Without the parent project the client cannot tell
        // those apart, which is exactly how the chart ended up showing two
        // identical "UI build" rows with nothing to distinguish them.
        project: { select: { id: true, name: true } },
        timeEntries: {
          where: { ...approvedOnly, userId: { in: visibleUserIds }, ...activityDateFilter(window) },
          include: { user: { select: { id: true, name: true } } },
        },
      },
    });
    return subtasks.map((s) => {
      const byMember = new Map<string, { member: string; hours: number }>();
      let total = 0;
      for (const e of s.timeEntries) {
        const h = Number(e.hours);
        total += h;
        const row = byMember.get(e.user.id) ?? { member: e.user.name, hours: 0 };
        row.hours += h;
        byMember.set(e.user.id, row);
      }
      return {
        subtaskId: s.id,
        subtask: s.name,
        projectId: s.project.id,
        project: s.project.name,
        totalHours: round2(total),
        byMember: [...byMember.values()].map((m) => ({ ...m, hours: round2(m.hours) })),
      };
    });
  }

  // ===== Team (aggregate — shared by Team Member and Team Lead) =============

  /**
   * The user ids whose hours make up "the team" for this viewer.
   *
   * Team Member → every active member of the one team they belong to (exclusive
   * membership makes that team unambiguous). Team Lead → every active member
   * across the teams they lead. Anyone with no live team gets an empty set,
   * which yields an empty aggregate rather than a leak of unrelated hours.
   */
  private async teamMemberIdsFor(actor: AuthUser): Promise<string[]> {
    const teamFilter =
      actor.role === Role.TEAM_LEAD
        ? { teamLeadId: actor.id, deletedAt: null }
        : { deletedAt: null, memberships: { some: { userId: actor.id, removedAt: null } } };
    const teams = await this.prisma.team.findMany({
      where: teamFilter,
      select: { memberships: { where: { removedAt: null }, select: { userId: true } } },
    });
    return [...new Set(teams.flatMap((t) => t.memberships.map((m) => m.userId)))];
  }

  /**
   * Team-wide hours grouped by Project → Task, for the team dashboard.
   *
   * ACCESS CONTROL: the result deliberately carries no per-member figures and no
   * member identities — only `memberCount`. A Team Member may see what their team
   * spent time on, never who spent it. The entry query therefore `select`s only
   * the aggregate inputs, so no userId is ever loaded into a shape that could be
   * serialised by accident; inspecting the network response reveals nothing
   * beyond these totals. Team Leads get the same aggregate as a complementary
   * view — their existing per-member breakdown lives in teamLeadHourDistribution
   * and is untouched.
   *
   * Counts APPROVED hours only, like every other visualisation (see
   * status.util). Pending time is reported separately by pendingHours().
   */
  async teamAggregateHours(actor: AuthUser, range?: string, startDate?: string, endDate?: string) {
    const window = resolveActivityRange(range, startDate, endDate);
    const memberIds = await this.teamMemberIdsFor(actor);
    const base = {
      range: window.r,
      from: window.gte ? window.gte.toISOString().slice(0, 10) : null,
      to: window.lt ? new Date(window.lt.getTime() - 86_400_000).toISOString().slice(0, 10) : null,
      memberCount: memberIds.length,
      totalHours: 0,
      projects: [] as unknown[],
    };
    if (!memberIds.length) return base;

    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: { in: memberIds },
        ...approvedOnly,
        // Non-leave only, matching My Progress's project → task hierarchy.
        OR: [{ subtaskId: { not: null } }, { projectId: { not: null } }],
        ...activityDateFilter(window),
      },
      // No userId / user relation: per-member data must not reach the response.
      select: {
        hours: true,
        subtaskId: true,
        subtask: { select: { id: true, name: true, projectId: true, project: { select: { name: true } } } },
        project: { select: { id: true, name: true } },
      },
    });

    type Task = { subtaskId: string | null; name: string; totalHours: number };
    type Proj = { projectId: string; projectName: string; totalHours: number; tasks: Record<string, Task> };
    const projects: Record<string, Proj> = {};
    let grand = 0;
    for (const e of entries) {
      const projId = e.subtask ? e.subtask.projectId : e.project?.id;
      const projName = e.subtask ? e.subtask.project.name : (e.project?.name ?? 'Project');
      if (!projId) continue;
      const h = Number(e.hours);
      grand += h;
      const p = (projects[projId] = projects[projId] ?? { projectId: projId, projectName: projName, totalHours: 0, tasks: {} });
      p.totalHours += h;
      const key = e.subtaskId ?? 'general';
      const t = (p.tasks[key] = p.tasks[key] ?? {
        subtaskId: e.subtaskId,
        name: e.subtask ? e.subtask.name : 'General / project time',
        totalHours: 0,
      });
      t.totalHours += h;
    }

    return {
      ...base,
      totalHours: round2(grand),
      projects: Object.values(projects)
        .map((p) => ({
          projectId: p.projectId,
          projectName: p.projectName,
          totalHours: round2(p.totalHours),
          tasks: Object.values(p.tasks)
            .map((t) => ({ ...t, totalHours: round2(t.totalHours) }))
            .sort((a, b) => b.totalHours - a.totalHours),
        }))
        .sort((a, b) => b.totalHours - a.totalHours),
    };
  }

  /**
   * Hours awaiting sign-off, so a chart that is empty *because nothing is
   * approved yet* can say so instead of reading as "no work logged".
   *
   * Returns two figures because a dashboard shows both kinds of card:
   *  - `mine`  — the viewer's own pending hours (personal cards).
   *  - `scope` — pending across what this role's team/company cards cover:
   *              Team Member → their team, Team Lead → teams they lead,
   *              PM/CEO → everyone.
   *
   * `scope` is an aggregate total only, never per person, so it cannot be used
   * to work out who is sitting on unapproved time.
   */
  async pendingHours(actor: AuthUser) {
    const sum = async (where: object) => {
      const agg = await this.prisma.timeEntry.aggregate({ _sum: { hours: true }, where });
      return round2(Number(agg._sum.hours ?? 0));
    };
    const mine = await sum({ userId: actor.id, ...pendingOnly });
    let scopeWhere: object;
    if (actor.role === Role.CEO || actor.role === Role.PM || actor.role === Role.ADMIN) {
      scopeWhere = { ...pendingOnly };
    } else {
      const ids = await this.teamMemberIdsFor(actor);
      // A lead is not a member of their own team, so include their own entries.
      scopeWhere = { userId: { in: [...new Set([actor.id, ...ids])] }, ...pendingOnly };
    }
    return { mine, scope: await sum(scopeWhere) };
  }

  // ===== Team Member ========================================================

  /** Personal hour distribution across own subtasks. */
  async memberHourDistribution(member: AuthUser) {
    const entries = await this.prisma.timeEntry.findMany({
      where: { userId: member.id, ...approvedOnly },
      include: { subtask: { select: { id: true, name: true } } },
    });
    const bySubtask = new Map<string, { subtask: string; hours: number }>();
    for (const e of entries) {
      const key = e.subtask?.id ?? 'leave';
      const label = e.subtask?.name ?? `Leave (${e.entryType})`;
      const row = bySubtask.get(key) ?? { subtask: label, hours: 0 };
      row.hours += Number(e.hours);
      bySubtask.set(key, row);
    }
    return [...bySubtask.values()].map((r) => ({ ...r, hours: round2(r.hours) }));
  }
}
