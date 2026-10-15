import { Role } from '@prisma/client';

/**
 * Central, machine-readable copy of the Phase 2 permission matrix.
 *
 * This is the single source of truth for *role-level* authorization. It answers
 * "may a role perform this action at all?". Finer-grained, row-level rules
 * (e.g. "own subtasks only", "own assignments only") are enforced in the
 * service layer in Phase 3 — they cannot be expressed by role membership alone.
 */
export enum Action {
  CREATE_PROJECT = 'CREATE_PROJECT',
  CREATE_SUBTASK = 'CREATE_SUBTASK',
  ASSIGN_SUBTASK_TO_TEAM_LEAD = 'ASSIGN_SUBTASK_TO_TEAM_LEAD',
  ASSIGN_SUBTASK_TO_TEAM_MEMBER = 'ASSIGN_SUBTASK_TO_TEAM_MEMBER',
  LOG_TIME_ENTRY = 'LOG_TIME_ENTRY',
  APPROVE_OR_REVERT_TIMESHEET = 'APPROVE_OR_REVERT_TIMESHEET',
  VIEW_OPERATIONAL_SUBTASK_DETAIL = 'VIEW_OPERATIONAL_SUBTASK_DETAIL',
  CREATE_EDIT_REQUEST = 'CREATE_EDIT_REQUEST',
  REVIEW_EDIT_REQUEST = 'REVIEW_EDIT_REQUEST',
  SUBMIT_FOR_APPROVAL = 'SUBMIT_FOR_APPROVAL',
  VIEW_AUDIT_LOG = 'VIEW_AUDIT_LOG',
  // v3 additions
  CREATE_DELETE_TEAM = 'CREATE_DELETE_TEAM',
  PROMOTE_DEMOTE = 'PROMOTE_DEMOTE',
  MANAGE_OWN_TEAM_MEMBERS = 'MANAGE_OWN_TEAM_MEMBERS',
  ARCHIVE_PROJECT = 'ARCHIVE_PROJECT',
}

/** Which roles may perform each action (role-level gate only). */
export const PERMISSION_MATRIX: Record<Action, Role[]> = {
  [Action.CREATE_PROJECT]: [Role.CEO],
  [Action.CREATE_SUBTASK]: [Role.PM],
  [Action.ASSIGN_SUBTASK_TO_TEAM_LEAD]: [Role.PM],
  [Action.ASSIGN_SUBTASK_TO_TEAM_MEMBER]: [Role.TEAM_LEAD], // own subtasks only (service layer)
  // v5: every role logs time for themselves. Target rules (subtask assignment vs
  // project-level) are enforced per-role in the service layer.
  [Action.LOG_TIME_ENTRY]: [Role.CEO, Role.PM, Role.TEAM_LEAD, Role.TEAM_MEMBER],
  [Action.APPROVE_OR_REVERT_TIMESHEET]: [Role.PM],
  [Action.VIEW_OPERATIONAL_SUBTASK_DETAIL]: [
    Role.CEO,
    Role.PM,
    Role.TEAM_LEAD, // own only (service layer)
    Role.TEAM_MEMBER, // own only (service layer)
  ],
  // v5: any role can own locked entries, so any role can request an edit (own entries only).
  [Action.CREATE_EDIT_REQUEST]: [Role.CEO, Role.PM, Role.TEAM_LEAD, Role.TEAM_MEMBER],
  [Action.REVIEW_EDIT_REQUEST]: [Role.PM],
  [Action.SUBMIT_FOR_APPROVAL]: [Role.TEAM_MEMBER],
  [Action.VIEW_AUDIT_LOG]: [Role.CEO, Role.PM], // PM scoped to own projects (service layer)
  [Action.CREATE_DELETE_TEAM]: [Role.PM],
  [Action.PROMOTE_DEMOTE]: [Role.PM], // only Member <-> Lead (service layer enforces tiers)
  [Action.MANAGE_OWN_TEAM_MEMBERS]: [Role.TEAM_LEAD], // own team only (service layer)
  [Action.ARCHIVE_PROJECT]: [Role.CEO, Role.PM],
};

export function rolesForAction(action: Action): Role[] {
  return PERMISSION_MATRIX[action];
}
