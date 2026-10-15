import { TimeEntryStatus } from '@prisma/client';
import { Db } from './db.types';
import { weekStartOf } from './time.util';

/** UTC month key, e.g. "2026-07". */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** ISO-ish week key based on the Monday week start, e.g. "2026-W29". */
export function weekKey(d: Date): string {
  const ws = weekStartOf(d);
  // Week number = ordinal of the Monday within its year (good enough for bucketing).
  const jan1 = new Date(Date.UTC(ws.getUTCFullYear(), 0, 1));
  const week = Math.floor((ws.getTime() - jan1.getTime()) / (7 * 86400_000)) + 1;
  return `${ws.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const APPROVED_LIKE: TimeEntryStatus[] = [TimeEntryStatus.APPROVED];

/**
 * Rebuild a project's hours summaries (month + week granularity) from raw entries.
 * Delete-then-recreate keeps it correct and simple. Runs inside the caller's tx,
 * on the same transaction as the status change that triggered it.
 */
export async function recomputeProjectSummaries(tx: Db, projectId: string) {
  const entries = await tx.timeEntry.findMany({
    where: { subtask: { projectId } },
    select: { date: true, hours: true, status: true },
  });

  type Bucket = { total: number; pending: number; approved: number };
  const month = new Map<string, Bucket>();
  const week = new Map<string, Bucket>();
  const add = (map: Map<string, Bucket>, key: string, hours: number, status: TimeEntryStatus) => {
    const b = map.get(key) ?? { total: 0, pending: 0, approved: 0 };
    b.total += hours;
    if (status === TimeEntryStatus.PENDING) b.pending += hours;
    if (APPROVED_LIKE.includes(status)) b.approved += hours;
    map.set(key, b);
  };
  for (const e of entries) {
    const h = Number(e.hours);
    add(month, monthKey(e.date), h, e.status);
    add(week, weekKey(e.date), h, e.status);
  }

  await tx.projectHoursSummary.deleteMany({ where: { projectId } });
  const rows = [
    ...[...month].map(([period, b]) => ({ period, periodType: 'MONTH' as const, b })),
    ...[...week].map(([period, b]) => ({ period, periodType: 'WEEK' as const, b })),
  ];
  for (const r of rows) {
    await tx.projectHoursSummary.create({
      data: {
        projectId,
        period: r.period,
        periodType: r.periodType,
        totalHours: r.b.total,
        pendingHours: r.b.pending,
        approvedHours: r.b.approved,
      },
    });
  }
}
