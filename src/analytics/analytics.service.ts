import { Injectable } from '@nestjs/common';
import { Role, TimeEntryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { APPROVED_ONLY, approvedOnly } from '../common/status.util';
import { DateRange } from '../common/range.util';
import { round2 } from '../common/time.util';

const DAILY_CAP = 8;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ===== CEO ================================================================

  /** Company overview — hours/headcount only (no money figures). */
  async ceoOverview(range: DateRange) {
    const [activeProjects, headcountRows] = await Promise.all([
      this.prisma.project.count({ where: { archivedAt: null } }),
      this.prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    ]);

    // Range-scoped approved hours — the period figure the CEO strip shows.
    const periodAgg = await this.prisma.timeEntry.aggregate({
      where: { status: { in: APPROVED_ONLY }, date: { gte: range.gte, lt: range.lt } },
      _sum: { hours: true },
    });

    const headcount: Record<string, number> = {};
    for (const r of headcountRows) headcount[r.role] = r._count._all;

    return {
      total_active_projects: activeProjects,
      total_hours_this_period: round2(Number(periodAgg._sum.hours ?? 0)),
      headcount_by_role: headcount,
    };
  }

  /** Resource allocation — approved hours per project within range. */
  async ceoResourceAllocation(range: DateRange) {
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        status: { in: APPROVED_ONLY },
        date: { gte: range.gte, lt: range.lt },
        subtaskId: { not: null },
      },
      include: { subtask: { select: { project: { select: { name: true } } } } },
    });
    const byProject = new Map<string, number>();
    for (const e of entries) {
      const label = e.subtask?.project.name ?? 'Unknown';
      byProject.set(label, (byProject.get(label) ?? 0) + Number(e.hours));
    }
    return [...byProject].map(([label, hours]) => ({ label, hours: round2(hours) })).sort((a, b) => b.hours - a.hours);
  }

  // ===== PM =================================================================

  async pmProjectsSummary(range: DateRange) {
    const projects = await this.prisma.project.findMany({
      where: { archivedAt: null },
      include: {
        subtasks: {
          include: {
            timeEntries: { where: { date: { gte: range.gte, lt: range.lt } } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return projects.map((p) => {
      let total = 0;
      let pending = 0;
      let approved = 0;
      const perUserDay = new Map<string, number>();
      for (const s of p.subtasks)
        for (const e of s.timeEntries) {
          const h = Number(e.hours);
          total += h;
          if (e.status === TimeEntryStatus.PENDING) pending += h;
          if (APPROVED_ONLY.includes(e.status)) approved += h;
          const k = `${e.userId}|${e.date.toISOString().slice(0, 10)}`;
          perUserDay.set(k, (perUserDay.get(k) ?? 0) + h);
        }
      const overtimeFlags = [...perUserDay.values()].filter((h) => h > DAILY_CAP).length;
      return {
        project: p.name,
        total_hours_logged: round2(total),
        pending_hours: round2(pending),
        approved_hours: round2(approved),
        overtime_flags: overtimeFlags,
      };
    });
  }

  /** Per-subtask burn-down — cumulative logged vs estimate + days to deadline. */
  async pmBurnDown(projectId: string) {
    const subtasks = await this.prisma.subtask.findMany({
      where: { projectId },
      include: { timeEntries: { where: approvedOnly, select: { hours: true } } },
      orderBy: { name: 'asc' },
    });
    const now = Date.now();
    return subtasks.map((s) => {
      const logged = s.timeEntries.reduce((sum, e) => sum + Number(e.hours), 0);
      const days =
        s.deadline != null
          ? Math.ceil((s.deadline.getTime() - now) / 86400_000)
          : null;
      return {
        subtask: s.name,
        estimated_hours: round2(Number(s.estimatedHours)),
        hours_logged: round2(logged),
        days_to_deadline: days,
      };
    });
  }

  async pmTaskStatus() {
    const subtasks = await this.prisma.subtask.findMany({
      include: {
        teamMemberAssignments: { where: { unassignedAt: null }, select: { id: true } },
        timeEntries: { select: { status: true } },
      },
    });
    let pending = 0;
    let approved = 0;
    let unassigned = 0;
    for (const s of subtasks) {
      if (s.teamMemberAssignments.length === 0) {
        unassigned++;
        continue;
      }
      const hasPending =
        s.timeEntries.length === 0 || s.timeEntries.some((e) => e.status === TimeEntryStatus.PENDING);
      if (hasPending) pending++;
      else approved++;
    }
    return [
      { label: 'Pending', count: pending },
      { label: 'Approved', count: approved },
      { label: 'Unassigned', count: unassigned },
    ];
  }

  // ===== Team Lead ==========================================================

  /** Own team's hours across the subtasks this lead owns, within range. */
  async teamLeadDistribution(actor: AuthUser, range: DateRange) {
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        ...approvedOnly,
        date: { gte: range.gte, lt: range.lt },
        subtask: { project: { teamLeadId: actor.id } },
      },
      include: { subtask: { select: { name: true } } },
    });
    const bySubtask = new Map<string, number>();
    for (const e of entries) {
      const label = e.subtask?.name ?? 'Unknown';
      bySubtask.set(label, (bySubtask.get(label) ?? 0) + Number(e.hours));
    }
    return [...bySubtask].map(([label, hours]) => ({ label, hours: round2(hours) })).sort((a, b) => b.hours - a.hours);
  }

  // ===== Team Member (me) ===================================================

  async myTimeDistribution(actor: AuthUser, range: DateRange) {
    const entries = await this.prisma.timeEntry.findMany({
      where: { userId: actor.id, ...approvedOnly, date: { gte: range.gte, lt: range.lt } },
      include: { subtask: { select: { name: true } } },
    });
    const byLabel = new Map<string, number>();
    for (const e of entries) {
      const label = e.subtask?.name ?? 'Leave';
      byLabel.set(label, (byLabel.get(label) ?? 0) + Number(e.hours));
    }
    return [...byLabel].map(([label, hours]) => ({ label, hours: round2(hours) })).sort((a, b) => b.hours - a.hours);
  }
}
