import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ApprovalStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubtasksService } from '../subtasks/subtasks.service';
import { AuthUser } from '../common/current-user.decorator';
import { weekStartOf, endOfWeek } from '../common/time.util';
import { PickDto } from './dto';

@Injectable()
export class TimesheetRowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subtasks: SubtasksService,
  ) {}

  /** Monday (UTC midnight) for a caller-supplied weekStart string. */
  private weekStart(weekStart: string): Date {
    return weekStartOf(new Date(weekStart));
  }

  /** A week is locked (no row add/remove/copy/prune) once submitted or approved. */
  private async assertWeekEditable(userId: string, ws: Date): Promise<void> {
    const approval = await this.prisma.approval.findUnique({
      where: { userId_weekStartDate: { userId, weekStartDate: ws } },
    });
    if (
      approval?.status === ApprovalStatus.SUBMITTED ||
      approval?.status === ApprovalStatus.APPROVED
    ) {
      throw new BadRequestException('This week is locked — rows cannot be changed');
    }
  }

  /**
   * The user's row markers for ONE week, resolved for display and grouped-ready.
   * Silently drops markers whose target was since deleted/archived (the row is
   * effectively gone — a manual re-add handles cleanup).
   */
  async list(user: AuthUser, weekStart: string) {
    const ws = this.weekStart(weekStart);
    const rows = await this.prisma.timesheetRow.findMany({
      where: { userId: user.id, weekStartDate: ws },
      include: {
        subtask: { include: { project: { select: { id: true, name: true, archivedAt: true } } } },
        project: { select: { id: true, name: true, archivedAt: true } },
      },
      orderBy: { addedAt: 'asc' },
    });
    return rows
      .filter((r) => {
        if (r.subtask) return !r.subtask.deletedAt && !r.subtask.project.archivedAt;
        if (r.project) return !r.project.archivedAt;
        return false;
      })
      .map((r) =>
        r.subtask
          ? {
              id: r.id,
              subtaskId: r.subtaskId,
              projectId: r.subtask.project.id,
              name: r.subtask.name,
              project: r.subtask.project.name,
            }
          : {
              id: r.id,
              projectId: r.project!.id,
              name: 'General / project time',
              project: r.project!.name,
            },
      );
  }

  /** Validate that the actor is allowed to log against this target (mirrors
   *  TimeEntriesService.resolveWorkTarget so the picker can't add off-scope rows).
   *  Project-level "General / project time" picks were removed — every new row
   *  must name a real subtask. `pick.projectId` is rejected the same as a pick
   *  with neither field set; existing project-only TimesheetRow markers from
   *  before this change are untouched and keep rendering via list() below. */
  private async assertPickAllowed(actor: AuthUser, pick: PickDto): Promise<void> {
    if (pick.subtaskId && pick.projectId) {
      throw new BadRequestException('Pick a subtask or a project, not both');
    }
    if (pick.subtaskId) {
      const subtask = await this.prisma.subtask.findUnique({ where: { id: pick.subtaskId } });
      if (!subtask || subtask.deletedAt) throw new BadRequestException('Subtask not available');
      if (actor.role === Role.TEAM_MEMBER && !(await this.subtasks.memberOnSubtask(actor.id, pick.subtaskId))) {
        throw new ForbiddenException('You are not assigned to this subtask');
      }
      if (actor.role === Role.TEAM_LEAD && !(await this.subtasks.leadOwnsSubtask(actor.id, pick.subtaskId))) {
        throw new ForbiddenException('You do not lead this subtask');
      }
      return; // CEO / PM: any existing subtask.
    }
    throw new BadRequestException('Each pick needs a subtask — project-level general time is no longer supported');
  }

  /**
   * Add picks to ONE week (idempotent — an already-added target for that week is
   * skipped, not errored). Creates only the row marker; the cells start empty
   * (no TimeEntries) so untouched days render as an add affordance, not a 0.
   */
  async add(actor: AuthUser, picks: PickDto[], weekStart: string) {
    const ws = this.weekStart(weekStart);
    await this.assertWeekEditable(actor.id, ws);
    for (const pick of picks) {
      await this.assertPickAllowed(actor, pick);
      await this.upsertMarker(actor.id, ws, pick.subtaskId ?? null, pick.subtaskId ? null : pick.projectId ?? null);
    }
    return this.list(actor, weekStart);
  }

  /** Create a week marker for a target if not already present (idempotent). */
  private async upsertMarker(userId: string, ws: Date, subtaskId: string | null, projectId: string | null) {
    const where = subtaskId
      ? { userId_subtaskId_weekStartDate: { userId, subtaskId, weekStartDate: ws } }
      : { userId_projectId_weekStartDate: { userId, projectId: projectId!, weekStartDate: ws } };
    const existing = await this.prisma.timesheetRow.findUnique({ where });
    if (existing) return;
    await this.prisma.timesheetRow.create({
      data: { userId, subtaskId, projectId, weekStartDate: ws },
    });
  }

  /**
   * Remove a row from its week (owner only). Deletes the marker AND that week's
   * TimeEntries for the same target — "remove this row from this week". The
   * caller confirms first when hours exist (the row would otherwise keep showing
   * off its entries). Never touches other weeks.
   */
  async remove(actor: AuthUser, id: string) {
    const row = await this.prisma.timesheetRow.findUnique({ where: { id } });
    if (!row || row.userId !== actor.id) throw new BadRequestException('Row not found');
    await this.assertWeekEditable(actor.id, row.weekStartDate);
    const weekStart = row.weekStartDate.toISOString().slice(0, 10);
    await this.prisma.$transaction([
      this.prisma.timeEntry.deleteMany({
        where: this.targetEntryWhere(actor.id, row.weekStartDate, row.subtaskId, row.projectId),
      }),
      this.prisma.timesheetRow.delete({ where: { id } }),
    ]);
    return this.list(actor, weekStart);
  }

  /** WHERE matching a single target's WORK entries within one week. */
  private targetEntryWhere(userId: string, ws: Date, subtaskId: string | null, projectId: string | null) {
    const range = { gte: ws, lt: endOfWeek(ws) };
    return subtaskId
      ? { userId, subtaskId, date: range }
      : { userId, projectId, subtaskId: null, date: range };
  }

  /**
   * Copy the previous week's rows onto `weekStart`.
   *  - mode 'tasks'  → add the same row markers only (all cells start empty).
   *  - mode 'hours'  → add the markers AND copy each of last week's WORK entries
   *    to the matching day this week (a pre-fill; nothing is submitted/approved).
   * Idempotent on markers; hour-copy skips a (target, day) that already has an
   * entry this week so it never doubles up or clobbers something already typed.
   */
  async copyPreviousWeek(actor: AuthUser, weekStart: string, mode: 'tasks' | 'hours') {
    const ws = this.weekStart(weekStart);
    await this.assertWeekEditable(actor.id, ws);
    const prevWs = new Date(ws);
    prevWs.setUTCDate(prevWs.getUTCDate() - 7);

    // Last week's rows = union of its markers and any target it logged real WORK on.
    const [prevMarkers, prevEntries] = await Promise.all([
      this.prisma.timesheetRow.findMany({ where: { userId: actor.id, weekStartDate: prevWs } }),
      this.prisma.timeEntry.findMany({
        where: { userId: actor.id, entryType: 'WORK', date: { gte: prevWs, lt: endOfWeek(prevWs) } },
      }),
    ]);

    // Distinct targets (subtask:<id> | project:<id>), preserving marker-vs-entry origin.
    const targets = new Map<string, { subtaskId: string | null; projectId: string | null }>();
    const keyOf = (s: string | null, p: string | null) => (s ? 's:' + s : 'p:' + p);
    for (const m of prevMarkers) targets.set(keyOf(m.subtaskId, m.projectId), { subtaskId: m.subtaskId, projectId: m.projectId });
    for (const e of prevEntries) targets.set(keyOf(e.subtaskId, e.projectId), { subtaskId: e.subtaskId, projectId: e.projectId });

    let copiedRows = 0;
    let copiedEntries = 0;
    for (const t of targets.values()) {
      // Skip targets whose subtask/project is no longer valid for this actor.
      const ok = await this.pickStillAllowed(actor, t.subtaskId, t.projectId);
      if (!ok) continue;
      await this.upsertMarker(actor.id, ws, t.subtaskId, t.projectId);
      copiedRows++;
      if (mode !== 'hours') continue;

      const rows = prevEntries.filter((e) => e.subtaskId === t.subtaskId && e.projectId === t.projectId);
      for (const src of rows) {
        const newDate = new Date(src.date);
        newDate.setUTCDate(newDate.getUTCDate() + 7);
        // Never clobber / double up an entry already present this week for this day.
        const existsSameDay = await this.prisma.timeEntry.findFirst({
          where: { userId: actor.id, subtaskId: t.subtaskId, projectId: t.projectId, date: newDate },
        });
        if (existsSameDay) continue;
        await this.prisma.timeEntry.create({
          data: {
            userId: actor.id,
            subtaskId: t.subtaskId,
            projectId: t.projectId,
            date: newDate,
            hours: new Prisma.Decimal(Number(src.hours)),
            entryType: src.entryType,
            billable: src.billable,
            notes: src.notes,
          },
        });
        copiedEntries++;
      }
    }
    return { copiedRows, copiedEntries, rows: await this.list(actor, weekStart) };
  }

  /**
   * Save-draft cleanup: drop every row of the week that has no hours logged
   * Mon–Sun. Deletes the marker and any (all-zero) TimeEntries for that target,
   * leaving nothing behind. Rows with any real hours (total > 0) are untouched,
   * so a deliberate single-day 0 inside an otherwise-worked row survives.
   */
  async pruneEmptyRows(actor: AuthUser, weekStart: string) {
    const ws = this.weekStart(weekStart);
    await this.assertWeekEditable(actor.id, ws);
    const range = { gte: ws, lt: endOfWeek(ws) };
    const [markers, entries] = await Promise.all([
      this.prisma.timesheetRow.findMany({ where: { userId: actor.id, weekStartDate: ws } }),
      this.prisma.timeEntry.findMany({ where: { userId: actor.id, entryType: 'WORK', date: range } }),
    ]);

    const keyOf = (s: string | null, p: string | null) => (s ? 's:' + s : 'p:' + p);
    const hoursByTarget = new Map<string, number>();
    for (const e of entries) {
      const k = keyOf(e.subtaskId, e.projectId);
      hoursByTarget.set(k, (hoursByTarget.get(k) ?? 0) + Number(e.hours));
    }

    // Every target present this week (via a marker or via entries).
    const targets = new Map<string, { subtaskId: string | null; projectId: string | null }>();
    for (const m of markers) targets.set(keyOf(m.subtaskId, m.projectId), { subtaskId: m.subtaskId, projectId: m.projectId });
    for (const e of entries) targets.set(keyOf(e.subtaskId, e.projectId), { subtaskId: e.subtaskId, projectId: e.projectId });

    let dropped = 0;
    for (const [k, t] of targets) {
      if ((hoursByTarget.get(k) ?? 0) > 0) continue; // has real hours — keep
      await this.prisma.$transaction([
        this.prisma.timeEntry.deleteMany({ where: this.targetEntryWhere(actor.id, ws, t.subtaskId, t.projectId) }),
        this.prisma.timesheetRow.deleteMany({
          where: {
            userId: actor.id,
            weekStartDate: ws,
            subtaskId: t.subtaskId,
            projectId: t.subtaskId ? null : t.projectId,
          },
        }),
      ]);
      dropped++;
    }
    return { dropped, rows: await this.list(actor, weekStart) };
  }

  /** Non-throwing variant of assertPickAllowed — used when copying old rows whose
   *  target may have since become off-scope (skip it silently). */
  private async pickStillAllowed(actor: AuthUser, subtaskId: string | null, projectId: string | null): Promise<boolean> {
    try {
      await this.assertPickAllowed(actor, { subtaskId: subtaskId ?? undefined, projectId: projectId ?? undefined });
      return true;
    } catch {
      return false;
    }
  }
}
