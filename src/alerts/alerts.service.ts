import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ApprovalStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { weekStartOf, endOfWeek, weekRangeLabel } from '../common/time.util';

/** A full week. Matches WEEK_HOURS_CAP, but is a *target*, not a limit. */
export const WEEK_TARGET_HOURS = 40;

/**
 * Roles that keep a timesheet. ADMIN is excluded deliberately — it is a system
 * role with no business data and no Timesheet tab, so an alert would be
 * unactionable noise.
 */
const TIMESHEET_ROLES: Role[] = [Role.CEO, Role.PM, Role.TEAM_LEAD, Role.TEAM_MEMBER];

/** "37:30" — same clock-style formatting the timesheet grid uses. */
function fmtHours(n: number): string {
  const mins = Math.round(n * 60);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Friday end-of-day nudge: anyone whose current week is tracking under a full
   * 40 hours AND is still editable gets one high-urgency notification.
   *
   * TIMEZONE — KNOWN LIMITATION. The cron fires on the server's local clock, and
   * the app has no per-user timezone anywhere (weeks are UTC Mon–Sun, the UI
   * renders UTC dates). So "Friday 18:00" means 18:00 in whatever zone the
   * server runs in, for everybody. For a single-site organisation that is
   * correct; for a distributed one, someone several zones away may receive this
   * outside their working day. Fixing it properly means storing a timezone per
   * user and bucketing the scan by zone — deliberately out of scope here rather
   * than guessed at. TZ and hour are configurable below so a deployment can at
   * least align the job with its own working day.
   */
  @Cron(process.env.HOURS_ALERT_CRON ?? '0 18 * * 5', {
    name: 'friday-under-40-alert',
    timeZone: process.env.HOURS_ALERT_TZ || undefined,
  })
  async fridayUnderTargetAlert() {
    if (this.config.get('HOURS_ALERT_ENABLED') === 'false') {
      this.logger.log('Friday hours alert skipped (HOURS_ALERT_ENABLED=false)');
      return;
    }
    const result = await this.runUnderTargetScan(new Date());
    this.logger.log(
      `Friday hours alert: ${result.notified} notified, ${result.skippedLocked} locked, ` +
        `${result.skippedOnTarget} on target, ${result.skippedAlreadySent} already alerted`,
    );
    return result;
  }

  /**
   * The scan itself, separated from the cron trigger so it can be run for an
   * explicit date (tests, a manual re-run, a backfill) without waiting for
   * Friday. `now` only decides WHICH week is checked — the same Monday-based
   * weekStartOf() the timesheet grid and Approval rows use, so "this week" means
   * exactly what the Table view shows.
   */
  async runUnderTargetScan(now: Date) {
    const ws = weekStartOf(now);
    const we = endOfWeek(ws);
    const wsKey = ws.toISOString().slice(0, 10);

    const users = await this.prisma.user.findMany({
      where: { role: { in: TIMESHEET_ROLES }, deletedAt: null },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);
    if (!userIds.length) return { weekStart: wsKey, notified: 0, skippedLocked: 0, skippedOnTarget: 0, skippedAlreadySent: 0 };

    // Three bulk reads rather than per-user queries: hours logged, lock state,
    // and who has already been alerted for this week.
    const [totals, approvals, alreadySent] = await Promise.all([
      this.prisma.timeEntry.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, date: { gte: ws, lt: we } },
        _sum: { hours: true },
      }),
      this.prisma.approval.findMany({
        where: { userId: { in: userIds }, weekStartDate: ws },
        select: { userId: true, status: true },
      }),
      this.prisma.notification.findMany({
        where: { userId: { in: userIds }, type: 'HOURS_ALERT', relatedEntityId: wsKey },
        select: { userId: true },
      }),
    ]);

    const hoursBy = new Map(totals.map((t) => [t.userId, Number(t._sum.hours ?? 0)]));
    const statusBy = new Map(approvals.map((a) => [a.userId, a.status]));
    const alertedIds = new Set(alreadySent.map((n) => n.userId));

    let notified = 0, skippedLocked = 0, skippedOnTarget = 0, skippedAlreadySent = 0;
    const rows: { userId: string; type: 'HOURS_ALERT'; message: string; relatedEntityId: string }[] = [];

    for (const id of userIds) {
      // Locked (SUBMITTED / APPROVED) → nothing they can still do about it, so
      // the alert would be pure nag. DRAFT (no Approval row) and REVERTED are
      // both editable and both get alerted.
      const status = statusBy.get(id);
      if (status === ApprovalStatus.SUBMITTED || status === ApprovalStatus.APPROVED) {
        skippedLocked++;
        continue;
      }
      const logged = hoursBy.get(id) ?? 0;
      if (logged >= WEEK_TARGET_HOURS) {
        skippedOnTarget++;
        continue;
      }
      // One alert per person per week, even if the job is retried or re-run.
      if (alertedIds.has(id)) {
        skippedAlreadySent++;
        continue;
      }
      const remaining = WEEK_TARGET_HOURS - logged;
      rows.push({
        userId: id,
        type: 'HOURS_ALERT',
        message:
          `Your logged hours for the week of ${weekRangeLabel(ws)} are ${fmtHours(logged)} — ` +
          `${fmtHours(remaining)} remaining to reach a full ${fmtHours(WEEK_TARGET_HOURS)} week. ` +
          `Complete your timesheet before it locks.`,
        relatedEntityId: wsKey,
      });
      notified++;
    }

    if (rows.length) await this.prisma.notification.createMany({ data: rows });
    return { weekStart: wsKey, notified, skippedLocked, skippedOnTarget, skippedAlreadySent };
  }
}
