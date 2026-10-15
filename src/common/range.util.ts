import { BadRequestException } from '@nestjs/common';
import { weekStartOf, endOfWeek } from './time.util';

export interface DateRange {
  gte: Date;
  lt: Date;
}

/** Half-open window where either bound may be absent ('lifetime' has neither). */
export interface OpenRange {
  r: string;
  gte?: Date;
  lt?: Date;
}

const ACTIVITY_RANGES = ['7d', '30d', '6m', '1y', 'custom', 'lifetime'];

/**
 * Resolve the *activity* `range` vocabulary — '7d' | '30d' | '6m' | '1y' |
 * 'custom' | 'lifetime', default '30d' — used by My Progress and the team
 * Dashboard.
 * Distinct from resolveRange() below, which serves the analytics endpoints'
 * week/month/quarter vocabulary; the two are not interchangeable.
 *
 * Unknown values fall back to '30d' rather than throwing, matching the original
 * behaviour of the personal-history endpoint this was extracted from. With
 * 'custom' both bounds are optional and an open end means "up to today".
 */
export function resolveActivityRange(range?: string, startDate?: string, endDate?: string): OpenRange {
  const r = ACTIVITY_RANGES.includes(range ?? '') ? (range as string) : '30d';
  const utcToday = () => {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  };
  let gte: Date | undefined;
  let lt: Date | undefined;
  if (r === 'custom') {
    if (startDate) gte = new Date(startDate + 'T00:00:00.000Z');
    const end = endDate ? new Date(endDate + 'T00:00:00.000Z') : utcToday();
    lt = new Date(end);
    lt.setUTCDate(lt.getUTCDate() + 1); // inclusive end date
  } else if (r === '6m') {
    gte = utcToday();
    gte.setUTCMonth(gte.getUTCMonth() - 6);
  } else if (r === '1y') {
    gte = utcToday();
    gte.setUTCFullYear(gte.getUTCFullYear() - 1);
  } else if (r !== 'lifetime') {
    gte = utcToday();
    gte.setUTCDate(gte.getUTCDate() - (r === '7d' ? 6 : 29));
  }
  return { r, gte, lt };
}

/** `date` Prisma filter for an OpenRange — `{}` when the range is unbounded. */
export function activityDateFilter(w: OpenRange) {
  return w.gte || w.lt ? { date: { ...(w.gte ? { gte: w.gte } : {}), ...(w.lt ? { lt: w.lt } : {}) } } : {};
}

/**
 * Resolve the analytics `range` query param into a concrete [gte, lt) window.
 * Supported: week | month | quarter | custom (+ start_date/end_date). Defaults
 * to the current week when omitted. All boundaries are UTC.
 */
export function resolveRange(range?: string, startDate?: string, endDate?: string): DateRange {
  const now = new Date();
  const kind = (range ?? 'week').toLowerCase();

  if (kind === 'week') {
    const gte = weekStartOf(now);
    return { gte, lt: endOfWeek(gte) };
  }
  if (kind === 'month') {
    const gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { gte, lt };
  }
  if (kind === 'quarter') {
    const q = Math.floor(now.getUTCMonth() / 3);
    const gte = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
    const lt = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1));
    return { gte, lt };
  }
  if (kind === 'custom') {
    if (!startDate || !endDate) {
      throw new BadRequestException('custom range requires start_date and end_date');
    }
    const gte = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(gte.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid start_date / end_date');
    }
    // end_date is inclusive → advance one day for the half-open upper bound.
    const lt = new Date(end);
    lt.setUTCDate(lt.getUTCDate() + 1);
    return { gte, lt };
  }
  throw new BadRequestException('range must be one of: week, month, quarter, custom');
}
