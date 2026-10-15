/**
 * Hours are stored as Decimal(6,2) but arrive from Prisma as JS floats, so
 * summing them drifts (0.1 + 0.2 = 0.30000000000000004) and leaks into the API
 * as values like 199.99000000000004. Every derived hour figure goes through
 * this before it leaves a service, so responses carry at most 2 decimals —
 * the precision the column actually stores.
 */
export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Monday-based week start for a given date, at UTC midnight. Used to group
 * TimeEntries into an Approval week.
 */
export function weekStartOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sun
  const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

export function endOfWeek(weekStart: Date): Date {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Jul 13 – Jul 19, 2026" — mirrors the frontend's weekRangeLabel exactly (UTC,
 * Monday-start, en dash) so notification text matches what the week navigator
 * shows. Used to resolve a human-readable week range at message-generation time.
 */
export function weekRangeLabel(weekStart: Date): string {
  const end = new Date(weekStart);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${fmt(weekStart)} – ${fmt(end)}, ${end.getUTCFullYear()}`;
}
