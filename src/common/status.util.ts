import { TimeEntryStatus } from '@prisma/client';

/**
 * Every hours *visualisation* in the app counts APPROVED time only — Dashboard
 * cards (all roles), Summary / My Progress, and the Calendar. A figure shown in
 * a chart, tile or report therefore always means "hours signed off by a
 * reviewer", never "hours somebody typed in".
 *
 * Deliberately NOT applied to the timesheet grid: that is the data-entry
 * surface, where the totals must reflect exactly what the user just entered.
 * Approvals and edit-requests also read raw entries, since their whole job is
 * to act on not-yet-approved time.
 *
 * Single source of truth so the surfaces can't drift apart again — they had
 * three different rules before this was introduced.
 */
export const APPROVED_ONLY: TimeEntryStatus[] = [TimeEntryStatus.APPROVED];

/** Spreadable `where` fragment: `{ ...approvedOnly, ...rest }`. */
export const approvedOnly = { status: { in: APPROVED_ONLY } } as const;

/** Counterpart used to report what is still awaiting sign-off. */
export const pendingOnly = { status: { in: [TimeEntryStatus.PENDING] } } as const;
