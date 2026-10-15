import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApprovalStatus, EntryType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { weekStartOf, endOfWeek, round2 } from '../common/time.util';
import { DateRange, activityDateFilter, resolveActivityRange } from '../common/range.util';
import { approvedOnly, pendingOnly } from '../common/status.util';
import { CreateTimeEntryDto, UpdateTimeEntryDto, TimerStartDto, DAY_HOURS_CAP, WEEK_HOURS_CAP } from './dto';

@Injectable()
export class TimeEntriesService {
  private readonly dailyCap: number;
  private readonly weeklyCap: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly subtasks: SubtasksService,
    config: ConfigService,
  ) {
    this.dailyCap = Number(config.get('DAILY_HOURS_CAP') ?? 8);
    this.weeklyCap = Number(config.get('WEEKLY_HOURS_CAP') ?? 40);
  }

  private isLeave(type: EntryType) {
    return type !== EntryType.WORK;
  }

  /**
   * True if the owning week is LOCKED for editing — i.e. it has an Approval row
   * with status SUBMITTED or APPROVED. No row (draft) or REVERTED = editable.
   */
  private async weekIsLocked(userId: string, date: Date): Promise<boolean> {
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId, weekStartDate: weekStartOf(date) } },
    });
    return (
      approval?.status === ApprovalStatus.SUBMITTED ||
      approval?.status === ApprovalStatus.APPROVED
    );
  }

  /**
   * Validate the WORK target (always a subtask) against the actor's role and
   * resolve which foreign key to store. Returns { subtaskId, projectId }.
   *  - Team Member: must have an active member assignment on the subtask.
   *  - Team Lead: must lead the subtask's project.
   *  - CEO/PM: any existing subtask (broad operational visibility).
   *
   * Project-level "General / project time" entries (subtaskId omitted, a bare
   * projectId instead) were removed — every WORK entry now names a real task.
   * `projectId` is still accepted as a parameter only so existing callers don't
   * need to change shape; it is never itself a valid target and is rejected
   * below like any other missing subtaskId.
   */
  private async resolveWorkTarget(
    actor: AuthUser,
    subtaskId?: string,
    projectId?: string,
  ): Promise<{ subtaskId: string | null; projectId: string | null }> {
    if (subtaskId && projectId) {
      throw new BadRequestException('Provide either a subtask or a project, not both');
    }
    if (subtaskId) {
      const subtask = await this.prisma.subtask.findUnique({ where: { id: subtaskId } });
      if (!subtask) throw new BadRequestException('Subtask not found');
      if (subtask.deletedAt) throw new BadRequestException('This subtask has been deleted');
      if (actor.role === Role.TEAM_MEMBER) {
        if (!(await this.subtasks.memberOnSubtask(actor.id, subtaskId))) {
          throw new ForbiddenException('You are not assigned to this subtask');
        }
      } else if (actor.role === Role.TEAM_LEAD) {
        if (!(await this.subtasks.leadOwnsSubtask(actor.id, subtaskId))) {
          throw new ForbiddenException('You do not lead this subtask');
        }
      }
      // CEO/PM: any existing subtask (broad operational visibility).
      return { subtaskId, projectId: null };
    }
    throw new BadRequestException('WORK entries require a subtaskId — project-level general time is no longer supported');
  }

  /**
   * HARD caps — unlike overtimeWarnings() below, these reject the write (400).
   *
   *  - a calendar day cannot exceed DAY_HOURS_CAP across ALL of that user's
   *    entries for the date (leave included — it is still a day of their life);
   *  - a project's weekly subtotal caps at WEEK_HOURS_CAP. (There is no
   *    separate per-task/row cap, and no cap on the week's grand total — a
   *    single task can run the whole week on its own, and a person working
   *    across several projects isn't bounded by a combined weekly figure.)
   *
   * `excludeEntryId` lets an update measure the week as it will be, not as it
   * is: the entry being edited is dropped before its new value is added in.
   * `previousHours` is that entry's current value (0 on create), needed to tell
   * a genuine increase from a decrease — without it, every save on an over-cap
   * row looks like an increase, because the excluded entry is missing from the
   * baseline being compared against.
   *
   * Only *increases* are rejected. Rows already over a cap (legacy data, or an
   * admin-side correction) can still be edited downwards or saved unchanged —
   * otherwise an over-limit week would be permanently frozen, with no way to fix
   * it from the UI that created it.
   */
  private async assertWithinCaps(
    userId: string,
    date: Date,
    newHours: number,
    target: { subtaskId: string | null; projectId: string | null },
    excludeEntryId?: string,
    previousHours = 0,
  ) {
    const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const ws = weekStartOf(date);

    const weekEntries = await this.prisma.timeEntry.findMany({
      where: {
        userId,
        date: { gte: ws, lt: endOfWeek(ws) },
        ...(excludeEntryId ? { id: { not: excludeEntryId } } : {}),
      },
      select: { hours: true, date: true, subtaskId: true, projectId: true },
    });

    const prior = weekEntries.map((e) => ({ ...e, h: Number(e.hours) }));
    const sum = (rows: { h: number }[]) => rows.reduce((s, r) => s + r.h, 0);
    // `before` omits the edited entry, so the scope's CURRENT total is
    // before + previousHours. Comparing against that is what distinguishes
    // "raising an over-cap total" from "lowering one".
    const rising = (before: number, after: number) => after > before + previousHours;
    const fmt = (n: number) => `${Math.floor(n)}:${String(Math.round((n % 1) * 60)).padStart(2, '0')}`;
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // --- 1. day total -------------------------------------------------------
    const dayPrior = prior.filter((e) => e.date >= dayStart && e.date < dayEnd);
    const dayBefore = sum(dayPrior);
    const dayAfter = dayBefore + newHours;
    if (dayAfter > DAY_HOURS_CAP && rising(dayBefore, dayAfter)) {
      throw new BadRequestException(
        `This would put ${DAY_NAMES[date.getUTCDay()]} at ${fmt(dayAfter)} — a day can't exceed ${fmt(DAY_HOURS_CAP)}`,
      );
    }

    // --- 2. the parent project's weekly subtotal ---------------------------
    // Resolved via the subtask when the target is a task, so a project's rows
    // are summed the same way the grid groups them.
    let projectId = target.projectId;
    if (target.subtaskId) {
      const st = await this.prisma.subtask.findUnique({
        where: { id: target.subtaskId },
        select: { projectId: true },
      });
      projectId = st?.projectId ?? null;
    }
    if (projectId) {
      const subtaskIds = (
        await this.prisma.subtask.findMany({ where: { projectId }, select: { id: true } })
      ).map((s) => s.id);
      const inProject = (e: { subtaskId: string | null; projectId: string | null }) =>
        (e.subtaskId && subtaskIds.includes(e.subtaskId)) || e.projectId === projectId;
      const projBefore = sum(prior.filter(inProject));
      const projAfter = projBefore + newHours;
      if (projAfter > WEEK_HOURS_CAP && rising(projBefore, projAfter)) {
        throw new BadRequestException(
          `This would put this project at ${fmt(projAfter)} for the week — a project can't exceed ${fmt(WEEK_HOURS_CAP)}`,
        );
      }
    }
  }

  /**
   * Public wrapper so other write paths (edit-request approval) are held to the
   * same caps without duplicating the arithmetic.
   */
  async assertWithinCapsFor(
    userId: string,
    date: Date,
    newHours: number,
    target: { subtaskId: string | null; projectId: string | null },
    excludeEntryId?: string,
    previousHours = 0,
  ) {
    return this.assertWithinCaps(userId, date, newHours, target, excludeEntryId, previousHours);
  }

  /** Overtime is flagged, never blocked. Returns human-readable warnings. */
  private async overtimeWarnings(userId: string, date: Date, addedHours: number): Promise<string[]> {
    const warnings: string[] = [];
    const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const dayAgg = await this.prisma.timeEntry.aggregate({
      where: { userId, date: { gte: dayStart, lt: dayEnd } },
      _sum: { hours: true },
    });
    const dayTotal = Number(dayAgg._sum.hours ?? 0) + addedHours;
    if (dayTotal > this.dailyCap) {
      warnings.push(`Daily hours ${dayTotal} exceed cap of ${this.dailyCap}`);
    }

    const ws = weekStartOf(date);
    const weekAgg = await this.prisma.timeEntry.aggregate({
      where: { userId, date: { gte: ws, lt: endOfWeek(ws) } },
      _sum: { hours: true },
    });
    const weekTotal = Number(weekAgg._sum.hours ?? 0) + addedHours;
    if (weekTotal > this.weeklyCap) {
      warnings.push(`Weekly hours ${weekTotal} exceed cap of ${this.weeklyCap}`);
    }
    return warnings;
  }

  // --- Create -----------------------------------------------------------
  // Every role logs time for themselves. WORK targets a subtask (assignment-gated
  // for Member/Lead) or a project (project-level/general time). LEAVE targets
  // neither. The week must not be locked (Submitted/Approved).
  async create(actor: AuthUser, dto: CreateTimeEntryDto) {
    const date = new Date(dto.date);

    let target: { subtaskId: string | null; projectId: string | null } = {
      subtaskId: null,
      projectId: null,
    };
    if (this.isLeave(dto.entryType)) {
      if (dto.subtaskId || dto.projectId) {
        throw new BadRequestException('Leave entries must not reference a subtask or project');
      }
    } else {
      target = await this.resolveWorkTarget(actor, dto.subtaskId, dto.projectId);
    }

    if (await this.weekIsLocked(actor.id, date)) {
      throw new BadRequestException(
        'This week is submitted for review — submit an Edit Request instead of editing entries',
      );
    }

    // Hours are stored exactly as entered — no 15-minute snapping. Decimal(6,2)
    // resolves to 0.6 of a minute, so every whole h:mm the UI can produce
    // round-trips unchanged.
    const hours = dto.hours;
    await this.assertWithinCaps(actor.id, date, hours, target);
    const warnings = await this.overtimeWarnings(actor.id, date, hours);

    const entry = await this.prisma.$transaction(async (tx) => {
      const created = await tx.timeEntry.create({
        data: {
          subtaskId: target.subtaskId,
          projectId: target.projectId,
          userId: actor.id,
          date,
          hours: new Prisma.Decimal(hours),
          entryType: dto.entryType,
          billable: dto.billable ?? !this.isLeave(dto.entryType),
          notes: dto.notes ?? null,
          roundedTo15Min: false,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIME_ENTRY_CREATED',
        entityType: 'TimeEntry',
        entityId: created.id,
        newValue: created,
      });
      return created;
    });

    return { ...entry, warnings };
  }

  // --- Update (owner only, blocked once week approved) ---------------------
  async update(actor: AuthUser, id: string, dto: UpdateTimeEntryDto) {
    const existing = await this.prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Time entry not found');
    if (existing.userId !== actor.id) throw new ForbiddenException('Not your time entry');
    if (await this.weekIsLocked(actor.id, existing.date)) {
      throw new BadRequestException(
        'Entry is locked (week submitted/approved) — use an Edit Request to change it',
      );
    }

    const newHours = dto.hours != null ? dto.hours : Number(existing.hours);
    if (dto.hours != null) {
      await this.assertWithinCaps(
        actor.id,
        existing.date,
        newHours,
        { subtaskId: existing.subtaskId, projectId: existing.projectId },
        existing.id,
        Number(existing.hours),
      );
    }
    const warnings =
      dto.hours != null
        ? await this.overtimeWarnings(actor.id, existing.date, newHours - Number(existing.hours))
        : [];

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.timeEntry.update({
        where: { id },
        data: {
          hours: dto.hours != null ? new Prisma.Decimal(newHours) : undefined,
          billable: dto.billable ?? undefined,
          notes: dto.notes ?? undefined,
          roundedTo15Min: dto.hours != null ? false : undefined,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIME_ENTRY_UPDATED',
        entityType: 'TimeEntry',
        entityId: id,
        oldValue: existing,
        newValue: u,
      });
      return u;
    });

    return { ...updated, warnings };
  }

  async remove(actor: AuthUser, id: string) {
    const existing = await this.prisma.timeEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Time entry not found');
    if (existing.userId !== actor.id) throw new ForbiddenException('Not your time entry');
    if (existing.status !== 'PENDING') {
      throw new BadRequestException('Only pending entries can be deleted');
    }
    if (await this.weekIsLocked(actor.id, existing.date)) {
      throw new BadRequestException('Entry is locked (week submitted/approved)');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.timeEntry.delete({ where: { id } });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIME_ENTRY_DELETED',
        entityType: 'TimeEntry',
        entityId: id,
        oldValue: existing,
      });
      return { deleted: true };
    });
  }

  // --- Read a week's grid --------------------------------------------------
  private async canViewTimesheetOf(viewer: AuthUser, targetUserId: string): Promise<boolean> {
    if (viewer.id === targetUserId) return true;
    if (viewer.role === Role.CEO || viewer.role === Role.PM) return true;
    if (viewer.role === Role.TEAM_LEAD) {
      // Own team members only: members on subtasks under a project this lead leads.
      const rows = await this.prisma.subtaskTeamMemberAssignment.findMany({
        where: {
          teamMemberId: targetUserId,
          subtask: { project: { teamLeadId: viewer.id } },
        },
        take: 1,
      });
      return rows.length > 0;
    }
    return false;
  }

  async getByWeek(viewer: AuthUser, targetUserId: string | undefined, weekStart: string) {
    const userId = targetUserId ?? viewer.id;
    if (!(await this.canViewTimesheetOf(viewer, userId))) {
      throw new ForbiddenException('Not permitted to view this timesheet');
    }
    const ws = weekStartOf(new Date(weekStart));
    const entries = await this.prisma.timeEntry.findMany({
      where: { userId, date: { gte: ws, lt: endOfWeek(ws) } },
      include: {
        subtask: { select: { id: true, name: true, projectId: true } },
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ date: 'asc' }],
    });
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId, weekStartDate: ws } },
    });
    // Locked for editing once submitted or approved; draft/reverted stays editable.
    const locked =
      approval?.status === ApprovalStatus.SUBMITTED || approval?.status === ApprovalStatus.APPROVED;
    const total = round2(entries.reduce((s, e) => s + Number(e.hours), 0));
    return { userId, weekStart: ws, locked, approval, total, entries };
  }

  /**
   * Calendar view: entries grouped by day for a date range, same visibility
   * rules as getByWeek. Used by the Calendar nav view.
   */
  async getCalendar(
    viewer: AuthUser,
    targetUserId: string | undefined,
    range: DateRange,
  ) {
    const userId = targetUserId ?? viewer.id;
    if (!(await this.canViewTimesheetOf(viewer, userId))) {
      throw new ForbiddenException('Not permitted to view this timesheet');
    }
    const entries = await this.prisma.timeEntry.findMany({
      // Approved only — the Calendar is a visualisation, not the entry surface
      // (see status.util). Freshly logged time appears once it is signed off.
      where: { userId, ...approvedOnly, date: { gte: range.gte, lt: range.lt } },
      include: {
        subtask: { select: { id: true, name: true, projectId: true } },
        // Needed so the Calendar's day hover tooltip can show a project name for
        // project-level (general) entries, which have no subtask to derive it from.
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ date: 'asc' }],
    });
    const byDay: Record<string, { date: string; hours: number; entries: typeof entries }> = {};
    for (const e of entries) {
      const key = e.date.toISOString().slice(0, 10);
      const day = (byDay[key] = byDay[key] ?? { date: key, hours: 0, entries: [] });
      day.hours += Number(e.hours);
      day.entries.push(e);
    }
    return {
      userId,
      range: { start: range.gte.toISOString().slice(0, 10), end: range.lt.toISOString().slice(0, 10) },
      days: Object.values(byDay)
        .map((d) => ({ ...d, hours: round2(d.hours) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  /**
   * Personal lifetime activity log for the logged-in user only (never a report on
   * anyone else — completely separate from a Team Lead's "Reviewing" access).
   * Groups the user's own WORK entries by Project → Subtask over the selected
   * range, summing hours and breaking each total down by entry status
   * (pending / approved) so official vs. still-pending is clear.
   *
   * `range`: '7d' | '30d' | '6m' | 'custom' | 'lifetime' (default '30d'). With
   * 'custom', `startDate`/`endDate` bound the window (inclusive). Leave entries
   * (no subtask and no project) are excluded — mirrors the Table view's hierarchy.
   */
  async getHistory(actor: AuthUser, range?: string, startDate?: string, endDate?: string) {
    // Shared with the team Dashboard's aggregate so both read the same window
    // for the same range value.
    const window = resolveActivityRange(range, startDate, endDate);
    const { r, gte, lt } = window;
    const dateFilter = activityDateFilter(window);
    const entries = await this.prisma.timeEntry.findMany({
      where: {
        userId: actor.id,
        // Non-leave only: a real subtask or project-level target.
        OR: [{ subtaskId: { not: null } }, { projectId: { not: null } }],
        ...dateFilter,
      },
      include: {
        subtask: { select: { id: true, name: true, projectId: true, project: { select: { name: true } } } },
        project: { select: { id: true, name: true } },
      },
    });

    // Project bucket → subtask bucket. A project-level ("general") entry rolls up
    // under a synthetic subtask key so it sits beside real subtasks in the group.
    //
    // Only APPROVED hours land in the buckets (see status.util) — every figure
    // this view renders means signed-off time. Pending hours are accumulated
    // separately into a single `pendingHours` total for the "Awaiting approval"
    // tile, rather than a per-row split.
    type Sub = { subtaskId: string | null; name: string; projectName: string; totalHours: number };
    type Proj = { projectId: string; projectName: string; totalHours: number; subtasks: Record<string, Sub> };
    const projects: Record<string, Proj> = {};
    let pendingHours = 0;

    for (const e of entries) {
      const h = Number(e.hours);
      if (e.status !== 'APPROVED') { pendingHours += h; continue; }
      const projId = e.subtask ? e.subtask.projectId : e.projectId;
      const projName = e.subtask ? e.subtask.project?.name ?? 'Project' : e.project?.name ?? 'Project';
      if (!projId) continue;
      const p = (projects[projId] = projects[projId] ?? { projectId: projId, projectName: projName, totalHours: 0, subtasks: {} });
      p.totalHours += h;

      const subKey = e.subtaskId ?? 'general';
      const subName = e.subtask ? e.subtask.name : 'General / project time';
      const s = (p.subtasks[subKey] = p.subtasks[subKey] ?? { subtaskId: e.subtaskId, name: subName, projectName: projName, totalHours: 0 });
      s.totalHours += h;
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const result = Object.values(projects)
      .map((p) => ({
        projectId: p.projectId,
        projectName: p.projectName,
        totalHours: round(p.totalHours),
        subtasks: Object.values(p.subtasks)
          .map((s) => ({ subtaskId: s.subtaskId, name: s.name, totalHours: round(s.totalHours) }))
          .sort((a, b) => b.totalHours - a.totalHours),
      }))
      .sort((a, b) => b.totalHours - a.totalHours);

    // Flat per-subtask series for the chart — same granularity as the grouped
    // table below it, so the bars and the rows always agree.
    const subtaskSeries = Object.values(projects)
      .flatMap((p) => Object.values(p.subtasks))
      .map((s) => ({
        subtaskId: s.subtaskId,
        label: s.name,
        project: s.projectName,
        hours: round(s.totalHours),
      }))
      .sort((a, b) => b.hours - a.hours);

    return {
      range: r,
      from: gte ? gte.toISOString().slice(0, 10) : null,
      to: lt ? new Date(lt.getTime() - 86_400_000).toISOString().slice(0, 10) : null,
      projects: result,
      // Own hours logged in this range that are still awaiting sign-off. Drives
      // the "Awaiting approval" tile and lets an empty chart explain itself.
      pendingHours: round(pendingHours),
      subtaskSeries,
    };
  }

  /**
   * Deep search: find subtasks/projects by name and report every date that had
   * hours logged against them, plus the hours per date.
   *
   * This is a *filter over already-visible data*, never a way to surface new
   * data. The `userId` scope below is the same rule the rest of this service
   * uses: CEO/PM see everyone, a Team Lead sees only their own team's members,
   * and everyone else sees only their own hours.
   */
  async deepSearch(
    viewer: AuthUser,
    query: string,
    scope?: string,
    range?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const q = (query ?? '').trim();
    if (q.length < 2) return { query: q, scope: scope ?? 'all', results: [] };
    const kind = scope === 'project' || scope === 'subtask' ? scope : 'all';
    const window = resolveActivityRange(range, startDate, endDate);

    // Visibility scope → a userId filter applied to every entry we read.
    let userFilter: Prisma.TimeEntryWhereInput = {};
    if (viewer.role === Role.CEO || viewer.role === Role.PM) {
      userFilter = {};
    } else if (viewer.role === Role.TEAM_LEAD) {
      // Own team: the lead's own entries plus those of members assigned to
      // subtasks under a project this lead leads.
      const rows = await this.prisma.subtaskTeamMemberAssignment.findMany({
        where: { subtask: { project: { teamLeadId: viewer.id } } },
        select: { teamMemberId: true },
        distinct: ['teamMemberId'],
      });
      userFilter = { userId: { in: [...new Set([viewer.id, ...rows.map((r) => r.teamMemberId)])] } };
    } else {
      userFilter = { userId: viewer.id };
    }

    // Deep search is a Dashboard card, so it reports approved hours only,
    // within the requested range.
    userFilter = { ...userFilter, ...approvedOnly, ...activityDateFilter(window) };

    const nameMatch = { contains: q, mode: Prisma.QueryMode.insensitive };
    const targetOr: Prisma.TimeEntryWhereInput[] = [];
    if (kind !== 'project') targetOr.push({ subtask: { name: nameMatch } });
    if (kind !== 'subtask') {
      targetOr.push({ project: { name: nameMatch } });
      targetOr.push({ subtask: { project: { name: nameMatch } } });
    }

    const entries = await this.prisma.timeEntry.findMany({
      where: { AND: [userFilter, { OR: targetOr }] },
      select: {
        date: true,
        hours: true,
        status: true,
        subtaskId: true,
        projectId: true,
        user: { select: { id: true, name: true } },
        subtask: { select: { id: true, name: true, project: { select: { id: true, name: true } } } },
        project: { select: { id: true, name: true } },
      },
      orderBy: { date: 'asc' },
    });

    // Group by the matched target, then by date within it.
    type Day = { date: string; hours: number; people: Set<string> };
    type Group = {
      kind: 'subtask' | 'project';
      id: string;
      label: string;
      project: string | null;
      totalHours: number;
      days: Map<string, Day>;
    };
    const groups = new Map<string, Group>();
    const push = (
      gKind: 'subtask' | 'project',
      id: string,
      label: string,
      project: string | null,
      date: Date,
      hours: number,
      person: string,
    ) => {
      const key = `${gKind}:${id}`;
      const g =
        groups.get(key) ?? { kind: gKind, id, label, project, totalHours: 0, days: new Map<string, Day>() };
      g.totalHours += hours;
      const dk = date.toISOString().slice(0, 10);
      const d = g.days.get(dk) ?? { date: dk, hours: 0, people: new Set<string>() };
      d.hours += hours;
      d.people.add(person);
      g.days.set(dk, d);
      groups.set(key, g);
    };

    const lower = q.toLowerCase();
    for (const e of entries) {
      const h = Number(e.hours);
      const person = e.user.name;
      const proj = e.subtask?.project ?? e.project;
      if (kind !== 'project' && e.subtask && e.subtask.name.toLowerCase().includes(lower)) {
        push('subtask', e.subtask.id, e.subtask.name, proj?.name ?? null, e.date, h, person);
      }
      if (kind !== 'subtask' && proj && proj.name.toLowerCase().includes(lower)) {
        push('project', proj.id, proj.name, null, e.date, h, person);
      }
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const results = [...groups.values()]
      .map((g) => ({
        kind: g.kind,
        id: g.id,
        label: g.label,
        project: g.project,
        totalHours: round(g.totalHours),
        days: [...g.days.values()]
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((d) => ({ date: d.date, hours: round(d.hours), people: [...d.people].sort() })),
      }))
      .sort((a, b) => b.totalHours - a.totalHours);

    return { query: q, scope: kind, results };
  }

  // --- Timer start / stop --------------------------------------------------
  async startTimer(actor: AuthUser, dto: TimerStartDto) {
    const target = await this.resolveWorkTarget(actor, dto.subtaskId, dto.projectId);
    const running = await this.prisma.timeEntry.findFirst({
      where: { userId: actor.id, timerStartedAt: { not: null } },
    });
    if (running) throw new BadRequestException('A timer is already running');

    const now = new Date();
    if (await this.weekIsLocked(actor.id, now)) {
      throw new BadRequestException('This week is submitted for review');
    }

    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.timeEntry.create({
        data: {
          subtaskId: target.subtaskId,
          projectId: target.projectId,
          userId: actor.id,
          date: now,
          hours: new Prisma.Decimal(0),
          entryType: EntryType.WORK,
          billable: true,
          notes: dto.notes ?? null,
          timerStartedAt: now,
        },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIMER_STARTED',
        entityType: 'TimeEntry',
        entityId: entry.id,
        newValue: entry,
      });
      return entry;
    });
  }

  async stopTimer(actor: AuthUser) {
    const running = await this.prisma.timeEntry.findFirst({
      where: { userId: actor.id, timerStartedAt: { not: null } },
    });
    if (!running || !running.timerStartedAt) {
      throw new BadRequestException('No timer is running');
    }
    // Elapsed time is recorded as measured, to the same 2dp the column holds.
    const elapsedHours = Math.round(((Date.now() - running.timerStartedAt.getTime()) / 3_600_000) * 100) / 100;
    const warnings = await this.overtimeWarnings(actor.id, running.date, elapsedHours);

    const stopped = await this.prisma.$transaction(async (tx) => {
      const u = await tx.timeEntry.update({
        where: { id: running.id },
        data: { hours: new Prisma.Decimal(elapsedHours), timerStartedAt: null, roundedTo15Min: false },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'TIMER_STOPPED',
        entityType: 'TimeEntry',
        entityId: running.id,
        oldValue: running,
        newValue: u,
      });
      return u;
    });
    return { ...stopped, elapsedHours: Number(elapsedHours.toFixed(4)), warnings };
  }
}
