// ---------------------------------------------------------------------------
// Phase 1.5 — comprehensive demo/test seed.
//
// Idempotent: TRUNCATEs every data table (RESTART IDENTITY CASCADE) and rebuilds
// the whole graph from scratch, so re-running never duplicates. Populates enough
// state-machine variety (draft / submitted / approved / reverted, overtime,
// edit requests, deactivated + deleted users) to
// exercise every role's view without any manual setup.
//
// Notifications + AuditLog are written directly here (the fast path the addendum
// permits) with a representative spread of every type, including read/resolved
// examples, so the Inbox and audit views are never empty.
//
// Demo logins (all password `password123`):
//   admin@ · ceo@ · pm@ · lead@ · member@demo.local
// admin@demo.local is seeded with must_change_password = true (per the Phase 6
// bootstrap note) — logging in as admin exercises the forced set-password screen;
// re-running the seed resets it. Every other demo account is directly usable.
// ---------------------------------------------------------------------------
import {
  PrismaClient,
  Role,
  EntryType,
  TimeEntryStatus,
  ApprovalStatus,
  EditRequestStatus,
  NotificationType,
  Prisma,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PW = 'password123';
const MS_DAY = 86_400_000;

// --- date helpers (UTC, Monday-based weeks) --------------------------------
function weekStartOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day));
  return d;
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_DAY);
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
function weekKey(d: Date) {
  const ws = weekStartOf(d);
  const jan1 = new Date(Date.UTC(ws.getUTCFullYear(), 0, 1));
  const week = Math.floor((ws.getTime() - jan1.getTime()) / (7 * MS_DAY)) + 1;
  return `${ws.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Week 7 = current week; weeks 1-6 are the past six; week 8 is next week (empty).
const curMon = weekStartOf(new Date());
const weekMon = (k: number) => addDays(curMon, (k - 7) * 7);

// Per-week lifecycle plan (member weeks). Week 7 is decided per-user below.
type WeekPlan = { approval: ApprovalStatus | null; entry: TimeEntryStatus };
function planFor(week: number): WeekPlan {
  if (week >= 1 && week <= 5) return { approval: ApprovalStatus.APPROVED, entry: TimeEntryStatus.APPROVED };
  if (week === 6) return { approval: ApprovalStatus.SUBMITTED, entry: TimeEntryStatus.PENDING };
  return { approval: null, entry: TimeEntryStatus.PENDING }; // draft
}

async function main() {
  const hash = await bcrypt.hash(PW, 10);

  // -------------------------------------------------------------------------
  // 0. Reset — truncate every data table so the seed is fully idempotent.
  // -------------------------------------------------------------------------
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "audit_logs","notifications","project_hours_summaries",
    "time_entry_edit_requests","approvals","time_entries",
    "subtask_team_member_assignments","project_team_lead_assignments","subtasks",
    "projects","clients","role_change_logs","team_memberships","teams","users"
    RESTART IDENTITY CASCADE`);

  // -------------------------------------------------------------------------
  // 1. Users — 1 admin, 1 CEO, 3 PMs, 8 leads, 40 members.
  // -------------------------------------------------------------------------
  type NewUser = Prisma.UserCreateManyInput;
  const userData: NewUser[] = [];
  const addUser = (email: string, name: string, role: Role, extra: Partial<NewUser> = {}) =>
    userData.push({ email, name, role, passwordHash: hash, mustChangePassword: false, ...extra });

  addUser('admin@demo.local', 'Ada Admin', Role.ADMIN, { mustChangePassword: true });
  addUser('ceo@demo.local', 'Casey CEO', Role.CEO);
  addUser('pm@demo.local', 'Priya PM', Role.PM);
  addUser('pm2@demo.local', 'Paul PM', Role.PM);
  addUser('pm3@demo.local', 'Pam PM', Role.PM);
  for (let i = 1; i <= 8; i++) {
    addUser(i === 1 ? 'lead@demo.local' : `lead${i}@demo.local`, i === 1 ? 'Lena Lead' : `Lee Lead ${i}`, Role.TEAM_LEAD);
  }
  for (let n = 1; n <= 40; n++) {
    const extra: Partial<NewUser> = {};
    if (n === 39) extra.deactivatedAt = addDays(curMon, -3); // ex-employee (login blocked)
    if (n === 40) extra.deletedAt = addDays(curMon, -5); // removed account (hidden from pickers)
    addUser(
      n === 1 ? 'member@demo.local' : `member${n}@demo.local`,
      n === 1 ? 'Sam Member' : `Mia Member ${n}`,
      Role.TEAM_MEMBER,
      extra,
    );
  }
  await prisma.user.createMany({ data: userData });

  const allUsers = await prisma.user.findMany();
  const byEmail = new Map(allUsers.map((u) => [u.email, u]));
  const U = (e: string) => byEmail.get(e)!;
  const admin = U('admin@demo.local');
  const ceo = U('ceo@demo.local');
  const pms = [U('pm@demo.local'), U('pm2@demo.local'), U('pm3@demo.local')];
  const pm1 = pms[0];
  const leads = allUsers.filter((u) => u.role === Role.TEAM_LEAD).sort((a, b) => a.email.localeCompare(b.email, undefined, { numeric: true }));
  const members = Array.from({ length: 40 }, (_, i) => U(i === 0 ? 'member@demo.local' : `member${i + 1}@demo.local`));

  // -------------------------------------------------------------------------
  // 2. Clients — 4 (name only; projects hang off them).
  // -------------------------------------------------------------------------
  await prisma.client.createMany({
    data: [
      { name: 'Acme Corp' },
      { name: 'Globex' },
      { name: 'Umbrella EU' },
      { name: 'Britannia Ltd' },
    ],
  });
  const clients = await prisma.client.findMany({ orderBy: { name: 'asc' } });
  const cli = (name: string) => clients.find((c) => c.name === name)!;

  // -------------------------------------------------------------------------
  // 3. Projects — 10 across 4 clients (8 active, 2 archived).
  // -------------------------------------------------------------------------
  const projDefs = [
    { name: 'Platform Modernization', client: 'Acme Corp', archived: false },
    { name: 'Website Rebuild', client: 'Acme Corp', archived: false },
    { name: 'Mobile App Revamp', client: 'Globex', archived: false },
    { name: 'Data Warehouse', client: 'Globex', archived: false },
    { name: 'Payments API', client: 'Umbrella EU', archived: false },
    { name: 'Customer Portal', client: 'Umbrella EU', archived: false },
    { name: 'Analytics Suite', client: 'Britannia Ltd', archived: false },
    { name: 'Banking System', client: 'Britannia Ltd', archived: false },
    { name: 'Legacy Migration', client: 'Acme Corp', archived: true }, // archived w/ history
    { name: 'Intranet Refresh', client: 'Globex', archived: true },
  ];
  await prisma.project.createMany({
    data: projDefs.map((p) => ({
      clientId: cli(p.client).id,
      name: p.name,
      deadline: addDays(curMon, 60),
      createdById: ceo.id,
      archivedAt: p.archived ? addDays(curMon, -14) : null,
    })),
  });
  const projects = await prisma.project.findMany();
  const P = (name: string) => projects.find((p) => p.name === name)!;
  // The 8 active projects, in a stable order, map 1:1 to the 8 teams/leads.
  const activeProjects = projDefs.filter((p) => !p.archived).map((p) => P(p.name));

  // -------------------------------------------------------------------------
  // 4. Teams (8) + memberships (5 each). Team 8 is leaderless; a couple of
  //    memberships are soft-removed to leave visible history.
  // -------------------------------------------------------------------------
  await prisma.team.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({
      name: `Team ${String.fromCharCode(65 + i)}`, // Team A..H
      teamLeadId: i === 7 ? null : leads[i].id, // Team H leaderless
      createdById: pm1.id,
      createdAt: addDays(curMon, -40),
    })),
  });
  const teams = await prisma.team.findMany({ orderBy: { name: 'asc' } });
  // Members 0-4 → Team A, 5-9 → Team B, ... 35-39 → Team H.
  const teamOf = (mi: number) => Math.floor(mi / 5);
  const membershipData: Prisma.TeamMembershipCreateManyInput[] = members.map((m, mi) => {
    const ti = teamOf(mi);
    const removed =
      mi === 39 // deleted member — also drop from roster
        ? addDays(curMon, -6)
        : mi === 19 // one ordinary soft-removed membership for history
          ? addDays(curMon, -10)
          : null;
    return {
      teamId: teams[ti].id,
      userId: m.id,
      addedById: (ti === 7 ? pm1 : leads[ti]).id, // leaderless team added by PM
      addedAt: addDays(curMon, -38),
      removedAt: removed,
    };
  });
  await prisma.teamMembership.createMany({ data: membershipData });

  // -------------------------------------------------------------------------
  // 5. Subtasks (5 per active project) + lead/member assignment waterfall.
  //    - Team H's project leaves 2 subtasks fully unassigned (Task-Status slice).
  //    - One subtask's lead is reassigned partway through (history to reconstruct).
  // -------------------------------------------------------------------------
  const SUBTASK_NAMES = ['Discovery', 'API development', 'UI build', 'Integration', 'QA & hardening'];
  const subtaskData: Prisma.SubtaskCreateManyInput[] = [];
  activeProjects.forEach((proj) => {
    SUBTASK_NAMES.forEach((sn, si) => {
      subtaskData.push({
        projectId: proj.id,
        name: sn,
        deadline: addDays(curMon, 30 + si * 5),
        estimatedHours: String(60 + si * 20) + '.00',
        createdById: pm1.id,
        createdAt: addDays(curMon, -39),
      });
    });
  });
  await prisma.subtask.createMany({ data: subtaskData });
  const allSubtasks = await prisma.subtask.findMany();
  const subtasksByProject = (pid: string) =>
    allSubtasks.filter((s) => s.projectId === pid);

  // Subtasks left with no team member assigned (Task-Status "Unassigned" slice).
  const teamHProject = activeProjects[7];
  const unassignedSubtaskIds = new Set(subtasksByProject(teamHProject.id).slice(3).map((s) => s.id));

  // v6 — one Team Lead owns the whole project. Active project i → lead i.
  const projectLeadHistory: Prisma.ProjectTeamLeadAssignmentCreateManyInput[] = [];
  for (let i = 0; i < activeProjects.length; i++) {
    await prisma.project.update({
      where: { id: activeProjects[i].id },
      data: { teamLeadId: leads[i].id },
    });
    // Platform Modernization (project 0) was handed to its current lead ~week 5.
    projectLeadHistory.push({
      projectId: activeProjects[i].id,
      teamLeadId: leads[i].id,
      assignedById: pm1.id,
      assignedAt: i === 0 ? weekMon(5) : addDays(curMon, -38),
    });
  }
  // Reassignment history: Platform Modernization was previously led by Lee Lead 2.
  projectLeadHistory.push({
    projectId: activeProjects[0].id,
    teamLeadId: leads[1].id,
    assignedById: pm1.id,
    assignedAt: addDays(curMon, -40),
    unassignedAt: weekMon(5),
  });
  await prisma.projectTeamLeadAssignment.createMany({ data: projectLeadHistory });

  // Members are still assigned to individual subtasks (by their project's lead).
  const memberAssignData: Prisma.SubtaskTeamMemberAssignmentCreateManyInput[] = [];
  activeProjects.forEach((proj, ti) => {
    const subs = subtasksByProject(proj.id);
    const leadSubs = subs.filter((s) => !unassignedSubtaskIds.has(s.id));
    const teamMembers = members.slice(ti * 5, ti * 5 + 5);
    teamMembers.forEach((m, li) => {
      const s = leadSubs[li % leadSubs.length];
      memberAssignData.push({
        subtaskId: s.id,
        teamMemberId: m.id,
        assignedById: leads[ti].id,
        assignedAt: addDays(curMon, -37),
      });
    });
  });
  await prisma.subtaskTeamMemberAssignment.createMany({ data: memberAssignData });

  // Map each member → the subtask they log against (their first active assignment).
  const memberSubtask = new Map<string, string>();
  memberAssignData.forEach((a) => {
    if (!memberSubtask.has(a.teamMemberId)) memberSubtask.set(a.teamMemberId, a.subtaskId);
  });
  const subtaskProject = new Map(allSubtasks.map((s) => [s.id, s.projectId]));

  // -------------------------------------------------------------------------
  // 6. Time entries + approvals across the 8-week window.
  // -------------------------------------------------------------------------
  const entryData: Prisma.TimeEntryCreateManyInput[] = [];
  const approvalData: Prisma.ApprovalCreateManyInput[] = [];

  const pushWeek = (
    userId: string,
    target: { subtaskId?: string; projectId?: string },
    week: number,
    plan: WeekPlan,
    opts: { baseHours?: number; overtimeDay?: number; leave?: { day: number; type: EntryType }[] } = {},
  ) => {
    const mon = weekMon(week);
    for (let d = 0; d < 5; d++) {
      const leave = opts.leave?.find((l) => l.day === d);
      const isOt = opts.overtimeDay === d;
      const hours = leave ? 8 : isOt ? 12 : opts.baseHours ?? 8;
      entryData.push({
        subtaskId: target.subtaskId ?? null,
        projectId: target.projectId ?? null,
        userId,
        date: addDays(mon, d),
        hours: String(hours),
        entryType: leave ? leave.type : EntryType.WORK,
        billable: leave ? false : (d + week) % 5 !== 0,
        notes: leave ? 'Time off' : isOt ? 'Crunch day — extra hours' : null,
        status: plan.entry,
      });
    }
    if (plan.approval) {
      approvalData.push({
        userId,
        weekStartDate: mon,
        approvedById: plan.approval === ApprovalStatus.APPROVED ? pm1.id : null,
        status: plan.approval,
        approvedAt: plan.approval === ApprovalStatus.APPROVED ? addDays(mon, 6) : null,
      });
    }
  };

  // Members submitting in the current (draft) week — "a couple already submitted".
  const week7Submitters = new Set([members[0].id, members[1].id]);

  members.forEach((m, mi) => {
    const sid = memberSubtask.get(m.id);
    if (!sid) return;
    const deactivated = mi === 38;
    const deleted = mi === 39;
    // Deactivated/deleted users only carry old approved history (weeks 1-2).
    const weeks = deactivated || deleted ? [1, 2] : [1, 2, 3, 4, 5, 6, 7];
    weeks.forEach((week) => {
      let plan = planFor(week);
      if (week === 7) {
        plan = week7Submitters.has(m.id)
          ? { approval: ApprovalStatus.SUBMITTED, entry: TimeEntryStatus.PENDING }
          : planFor(7);
      }
      const opts: Parameters<typeof pushWeek>[4] = {};
      if (mi === 1 && week === 5) opts.overtimeDay = 2; // Mia 2: a 12h day
      if (mi === 2 && week === 3) opts.baseHours = 10; // Mia 3: a 50h week
      if (mi === 3 && week === 2) opts.leave = [{ day: 1, type: EntryType.LEAVE_VACATION }, { day: 2, type: EntryType.LEAVE_VACATION }];
      if (mi === 4 && week === 3) opts.leave = [{ day: 4, type: EntryType.LEAVE_SICK }];
      if (mi === 5 && week === 1) opts.leave = [{ day: 0, type: EntryType.LEAVE_HOLIDAY }];
      pushWeek(m.id, { subtaskId: sid }, week, plan, opts);
    });
  });

  // Team leads log a little against their own project's first subtask (weeks 1-6).
  leads.forEach((ld, li) => {
    const subs = subtasksByProject(activeProjects[li].id).filter((s) => !unassignedSubtaskIds.has(s.id));
    if (!subs.length) return;
    [1, 2, 3, 4, 5, 6].forEach((week) => pushWeek(ld.id, { subtaskId: subs[0].id }, week, planFor(week), { baseHours: 3 }));
  });

  // Project-level entries (no subtask) — exercises the CEO/PM path.
  pushWeek(ceo.id, { projectId: activeProjects[0].id }, 5, planFor(5), { baseHours: 2 }); // approved
  pushWeek(ceo.id, { projectId: activeProjects[0].id }, 6, planFor(6), { baseHours: 2 }); // submitted
  pushWeek(pm1.id, { projectId: activeProjects[1].id }, 7, planFor(7), { baseHours: 2 }); // draft

  await prisma.timeEntry.createMany({ data: entryData });
  // Defensive dedupe: one Approval per (user, week). Same-week entries share a plan.
  const approvalSeen = new Set<string>();
  const uniqueApprovals = approvalData.filter((a) => {
    const key = `${a.userId}|${(a.weekStartDate as Date).toISOString().slice(0, 10)}`;
    if (approvalSeen.has(key)) return false;
    approvalSeen.add(key);
    return true;
  });
  await prisma.approval.createMany({ data: uniqueApprovals });

  // -------------------------------------------------------------------------
  // 7. Edit requests — one PENDING, one APPROVED (re-submitted), one DENIED.
  // -------------------------------------------------------------------------
  const lockedEntry = async (userId: string, week: number, status: TimeEntryStatus) =>
    prisma.timeEntry.findFirst({
      where: { userId, status, subtaskId: { not: null }, date: { gte: weekMon(week), lt: addDays(weekMon(week), 7) } },
    });
  const mkEditReq = (
    entry: { id: string; hours: Prisma.Decimal; notes: string | null; billable: boolean },
    requestedById: string,
    status: EditRequestStatus,
    reviewedById?: string,
  ): Prisma.TimeEntryEditRequestCreateManyInput => ({
    timeEntryId: entry.id,
    requestedById,
    oldValue: { hours: Number(entry.hours), notes: entry.notes, billable: entry.billable } as Prisma.InputJsonValue,
    proposedValue: { hours: Number(entry.hours) + 1, notes: 'Corrected hours', billable: entry.billable } as Prisma.InputJsonValue,
    reason: 'Logged the wrong number of hours',
    status,
    reviewedById: reviewedById ?? null,
    reviewedAt: status === EditRequestStatus.PENDING ? null : addDays(curMon, -1),
  });

  const pendReqEntry = await lockedEntry(members[9].id, 5, TimeEntryStatus.APPROVED); // week 5 = approved/locked
  const apprReqEntry = await lockedEntry(members[10].id, 6, TimeEntryStatus.PENDING); // week 6 = submitted/locked
  const denyReqEntry = await lockedEntry(members[11].id, 5, TimeEntryStatus.APPROVED);
  const editReqData: Prisma.TimeEntryEditRequestCreateManyInput[] = [];
  if (pendReqEntry) editReqData.push(mkEditReq(pendReqEntry, members[9].id, EditRequestStatus.PENDING));
  if (apprReqEntry) editReqData.push(mkEditReq(apprReqEntry, members[10].id, EditRequestStatus.APPROVED, pm1.id));
  if (denyReqEntry) editReqData.push(mkEditReq(denyReqEntry, members[11].id, EditRequestStatus.DENIED, pm1.id));
  await prisma.timeEntryEditRequest.createMany({ data: editReqData });
  const editReqs = await prisma.timeEntryEditRequest.findMany();
  const pendReq = editReqs.find((r) => r.status === EditRequestStatus.PENDING);
  const apprReq = editReqs.find((r) => r.status === EditRequestStatus.APPROVED);

  // -------------------------------------------------------------------------
  // 8. Role-change history — one seeded promotion (for the People → History view).
  // -------------------------------------------------------------------------
  await prisma.roleChangeLog.create({
    data: {
      userId: leads[0].id,
      oldRole: Role.TEAM_MEMBER,
      newRole: Role.TEAM_LEAD,
      changedById: pm1.id,
      reason: 'Promoted after consistently leading delivery',
      createdAt: addDays(curMon, -30),
    },
  });

  // -------------------------------------------------------------------------
  // 9. Notifications — representative spread of every type, incl. read/resolved.
  // -------------------------------------------------------------------------
  const week6Approvals = await prisma.approval.findMany({
    where: { weekStartDate: weekMon(6), status: ApprovalStatus.SUBMITTED },
    take: 5,
  });
  const notifData: Prisma.NotificationCreateManyInput[] = [];
  const note = (o: Prisma.NotificationCreateManyInput) => notifData.push(o);

  // Actionable SUBMISSION notifications in the PM inbox (drive the inline buttons).
  week6Approvals.forEach((a) => {
    const owner = allUsers.find((u) => u.id === a.userId);
    note({
      userId: pm1.id,
      type: NotificationType.SUBMISSION,
      message: `${owner?.name ?? 'Someone'} submitted their timesheet for review`,
      relatedEntityId: a.id,
      actionable: true,
      resolved: false,
      createdAt: addDays(weekMon(7), 0),
    });
  });
  // One already-actioned SUBMISSION (history — buttons hidden, tag remains).
  if (week6Approvals[0]) {
    note({
      userId: pm1.id,
      type: NotificationType.SUBMISSION,
      message: 'A resubmitted timesheet you already approved',
      relatedEntityId: week6Approvals[0].id,
      actionable: true,
      resolved: true,
      read: true,
      createdAt: addDays(weekMon(6), 6),
    });
  }
  // Actionable EDIT_REQUEST (PM inbox) + a resolved one.
  if (pendReq) {
    note({
      userId: pm1.id,
      type: NotificationType.EDIT_REQUEST,
      message: `Edit request from ${members[9].name}: Logged the wrong number of hours`,
      relatedEntityId: pendReq.id,
      actionable: true,
      resolved: false,
      createdAt: addDays(curMon, -1),
    });
  }
  if (apprReq) {
    note({ userId: pm1.id, type: NotificationType.EDIT_REQUEST, message: `Edit request from ${members[10].name}`, relatedEntityId: apprReq.id, actionable: true, resolved: true, read: true, createdAt: addDays(curMon, -2) });
    note({ userId: members[10].id, type: NotificationType.EDIT_RESOLVED, message: 'Your edit request was approved — the week is re-opened, please re-submit', relatedEntityId: apprReq.id, read: false, createdAt: addDays(curMon, -1) });
  }
  // Approval confirmations to employees (mix of read/unread).
  members.slice(0, 6).forEach((m, i) => {
    note({ userId: m.id, type: NotificationType.APPROVAL, message: 'Your timesheet was approved', relatedEntityId: null, read: i % 2 === 0, createdAt: addDays(weekMon(5), 6) });
    note({ userId: m.id, type: NotificationType.APPROVAL, message: 'Your timesheet was approved', relatedEntityId: null, read: i % 2 === 1, createdAt: addDays(weekMon(4), 6) });
  });
  // Assignment heads-ups.
  members.slice(0, 4).forEach((m) =>
    note({ userId: m.id, type: NotificationType.ASSIGNMENT, message: 'You were assigned to a new subtask', relatedEntityId: null, read: false, createdAt: addDays(curMon, -20) }),
  );
  // Team / role / membership lifecycle.
  note({ userId: leads[0].id, type: NotificationType.TEAM, message: 'You were made lead of team: Team A', relatedEntityId: teams[0].id, read: true, createdAt: addDays(curMon, -40) });
  note({ userId: leads[0].id, type: NotificationType.ROLE_CHANGE, message: 'You were promoted to Team Lead', relatedEntityId: null, read: true, createdAt: addDays(curMon, -30) });
  note({ userId: members[19].id, type: NotificationType.MEMBERSHIP, message: 'You were removed from team: Team D', relatedEntityId: teams[3].id, read: false, createdAt: addDays(curMon, -10) });
  // Account informational (to the deactivated member, from before they left).
  note({ userId: members[38].id, type: NotificationType.ACCOUNT, message: 'Your account was created. Please set a new password on first login.', relatedEntityId: members[38].id, read: true, createdAt: addDays(curMon, -38) });
  await prisma.notification.createMany({ data: notifData });

  // -------------------------------------------------------------------------
  // 10. Audit log — representative rows (so the CEO/PM audit view isn't empty).
  // -------------------------------------------------------------------------
  const anApproval = await prisma.approval.findFirst({ where: { status: ApprovalStatus.APPROVED } });
  const auditData: Prisma.AuditLogCreateManyInput[] = [
    { actorId: ceo.id, action: 'PROJECT_CREATED', entityType: 'Project', entityId: activeProjects[0].id, newValue: { name: activeProjects[0].name } as Prisma.InputJsonValue, createdAt: addDays(curMon, -39) },
    { actorId: pm1.id, action: 'SUBTASK_CREATED', entityType: 'Subtask', entityId: allSubtasks[0].id, newValue: { name: allSubtasks[0].name } as Prisma.InputJsonValue, createdAt: addDays(curMon, -38) },
    { actorId: pm1.id, action: 'TEAM_CREATED', entityType: 'Team', entityId: teams[0].id, newValue: { name: teams[0].name } as Prisma.InputJsonValue, createdAt: addDays(curMon, -40) },
    { actorId: pm1.id, action: 'MEMBER_ADDED_TO_TEAM', entityType: 'TeamMembership', entityId: teams[0].id, createdAt: addDays(curMon, -38) },
    { actorId: pm1.id, action: 'TIMESHEET_APPROVED', entityType: 'Approval', entityId: anApproval?.id ?? activeProjects[0].id, createdAt: addDays(weekMon(5), 6) },
    { actorId: pm1.id, action: 'ROLE_PROMOTED', entityType: 'User', entityId: leads[0].id, oldValue: { role: 'TEAM_MEMBER' } as Prisma.InputJsonValue, newValue: { role: 'TEAM_LEAD' } as Prisma.InputJsonValue, createdAt: addDays(curMon, -30) },
    { actorId: admin.id, action: 'USER_CREATED', entityType: 'User', entityId: members[0].id, newValue: { email: members[0].email } as Prisma.InputJsonValue, createdAt: addDays(curMon, -41) },
  ];

  // Project-entity history for the first three active projects, so the
  // (name-based) audit lookup returns a multi-row story for each of them.
  const auditProjects = activeProjects.slice(0, 3);
  auditProjects.forEach((p, i) => {
    const lead = leads[i % leads.length];
    auditData.push(
      { actorId: ceo.id, action: 'PROJECT_CREATED', entityType: 'Project', entityId: p.id, newValue: { name: p.name } as Prisma.InputJsonValue, createdAt: addDays(curMon, -39 + i) },
      { actorId: pm1.id, action: 'PROJECT_LEAD_ASSIGNED', entityType: 'Project', entityId: p.id, newValue: { teamLeadId: lead.id, teamLead: lead.name } as Prisma.InputJsonValue, createdAt: addDays(curMon, -34 + i) },
      { actorId: pm1.id, action: 'PROJECT_UPDATED', entityType: 'Project', entityId: p.id, oldValue: { deadline: null } as Prisma.InputJsonValue, newValue: { deadline: addDays(curMon, 60).toISOString().slice(0, 10) } as Prisma.InputJsonValue, createdAt: addDays(curMon, -20 + i) },
    );
  });
  // A lead reassignment on the first project (shows PROJECT_LEAD_CHANGED history).
  if (auditProjects[0] && leads.length > 1) {
    auditData.push({
      actorId: pm1.id,
      action: 'PROJECT_LEAD_CHANGED',
      entityType: 'Project',
      entityId: auditProjects[0].id,
      oldValue: { teamLead: leads[0].name } as Prisma.InputJsonValue,
      newValue: { teamLead: leads[1].name } as Prisma.InputJsonValue,
      createdAt: addDays(weekMon(5), 1),
    });
  }

  await prisma.auditLog.createMany({ data: auditData });

  // -------------------------------------------------------------------------
  // 11. Analytics summary tables — rebuild from the seeded entries.
  // -------------------------------------------------------------------------
  const APPROVED_LIKE: TimeEntryStatus[] = [TimeEntryStatus.APPROVED];
  for (const p of projects) {
    const entries = await prisma.timeEntry.findMany({ where: { subtask: { projectId: p.id } }, select: { date: true, hours: true, status: true } });
    const month = new Map<string, { total: number; pending: number; approved: number }>();
    const week = new Map<string, { total: number; pending: number; approved: number }>();
    const add = (map: typeof month, key: string, h: number, s: TimeEntryStatus) => {
      const b = map.get(key) ?? { total: 0, pending: 0, approved: 0 };
      b.total += h;
      if (s === TimeEntryStatus.PENDING) b.pending += h;
      if (APPROVED_LIKE.includes(s)) b.approved += h;
      map.set(key, b);
    };
    for (const e of entries) {
      const h = Number(e.hours);
      add(month, monthKey(e.date), h, e.status);
      add(week, weekKey(e.date), h, e.status);
    }
    const rows = [
      ...[...month].map(([period, b]) => ({ period, periodType: 'MONTH' as const, b })),
      ...[...week].map(([period, b]) => ({ period, periodType: 'WEEK' as const, b })),
    ];
    for (const r of rows) {
      await prisma.projectHoursSummary.create({
        data: { projectId: p.id, period: r.period, periodType: r.periodType, totalHours: r.b.total, pendingHours: r.b.pending, approvedHours: r.b.approved },
      });
    }
  }

  // -------------------------------------------------------------------------
  // 12. Summary output.
  // -------------------------------------------------------------------------
  const counts = await prisma.user.groupBy({ by: ['role'], _count: true });
  const entryCount = await prisma.timeEntry.count();
  const notifCount = await prisma.notification.count();
  const auditCount = await prisma.auditLog.count();

  console.log('\n=== Seed complete ===');
  console.log('\nUsers by role:');
  for (const c of counts.sort((a, b) => a.role.localeCompare(b.role))) console.log(`  ${c.role.padEnd(12)} ${c._count}`);
  console.log('    (member39 = deactivated, member40 = deleted)');

  console.log('\nProjects → status:');
  for (const p of projects) {
    const label = p.archivedAt ? 'ARCHIVED' : 'ACTIVE';
    console.log(`  ${p.name.padEnd(24)} ${label}`);
  }

  console.log('\nWeeks → member timesheet state (Monday date):');
  const rows: [string, string][] = [
    [`${weekMon(1).toISOString().slice(0, 10)}..${weekMon(5).toISOString().slice(0, 10)}`, 'weeks 1-5: APPROVED (Approval APPROVED, entries APPROVED)'],
    [weekMon(6).toISOString().slice(0, 10), 'week 6: SUBMITTED, in PM inbox'],
    [weekMon(7).toISOString().slice(0, 10), 'week 7 (current): mixed draft + 2 submitted'],
    [weekMon(8).toISOString().slice(0, 10), 'week 8 (next): empty'],
  ];
  for (const [d, s] of rows) console.log(`  ${d.padEnd(24)} ${s}`);

  console.log('\nState-machine extras:');
  console.log(`  time entries: ${entryCount}  ·  notifications: ${notifCount}  ·  audit rows: ${auditCount}`);
  console.log(`  edit requests: ${editReqs.length} (1 PENDING in PM inbox, 1 APPROVED, 1 DENIED)`);
  console.log('  overtime: Mia Member 3 (12h day, wk5), Mia Member 4 (50h week, wk3) — flagged, not blocked');
  console.log('  leave: vacation/sick/holiday scattered in weeks 1-3');
  console.log('  project-level entries: CEO, PM (no subtask)');
  console.log('  unassigned subtasks: 2 on Team H project (Task-Status "Unassigned" slice)');
  console.log('  project leads: one Team Lead per active project (v6); Platform Modernization reassigned ~wk5\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
