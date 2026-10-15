# Enterprise Scheduling & Timesheet System

Backend-first build (NestJS + Prisma + PostgreSQL). **Phase 1 (Database Schema) is complete.**

## Stack
- **Backend:** Node.js + NestJS 10
- **ORM/DB:** Prisma 5 + PostgreSQL 18
- **Auth/RBAC:** planned for Phase 2 (JWT + `RolesGuard`)

## Status by phase
| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Database schema + migrations | ✅ Done |
| 2 | RBAC & JWT auth | ✅ Done |
| 3 | Core API endpoints | ✅ Done |
| 4 | Business logic / state machines | ✅ Done (built alongside Phase 3 endpoints) |
| 5 | Dashboard data endpoints | ✅ Done |
| 6 | Login page (unstyled) | ✅ Done |
| 7 | Sidebar shell (unstyled) | ✅ Done |

**All 7 phases complete.**

## Setup
1. Copy `.env.example` → `.env` and set `DATABASE_URL` (Postgres 18 on `localhost:5432`).
2. Install: `npm install`
3. Migrate: `npx prisma migrate dev`
4. Seed demo data: `npx prisma db seed`
5. Run: `npm run start:dev` → API at `http://localhost:3000/api` (health check: `GET /api/health`)

## Schema (Phase 1)
11 domain tables mapping the master prompt entities:
`users`, `clients`, `projects`, `subtasks`, `subtask_team_lead_assignments`,
`subtask_team_member_assignments`, `time_entries`, `time_entry_edit_requests`,
`approvals`, `notifications`, `audit_logs`.

Key rules are modeled in the schema and will be **enforced at the service layer** in later phases:
- TimeEntry locked once its parent Approval is `APPROVED` (edits only via EditRequest).
- Approving an EditRequest reverts the Approval to `PENDING`.
- Assignment history preserved via `assigned_at` / `unassigned_at` (no retroactive change to past entries).
- Project hours summaries (month + week) recomputed in the same transaction as any status change.

## Auth & RBAC (Phase 2)
JWT auth with the role embedded in the token, validated server-side on every request.

- **Global `JwtAuthGuard`** — every endpoint requires a valid Bearer access token unless marked `@Public()`.
- **Global `RolesGuard`** — enforces role-level access from `@Roles(...)` / `@RequirePermission(Action.X)` metadata.
- **Permission matrix** lives in [`src/rbac/permissions.ts`](src/rbac/permissions.ts) as the single source of truth. Row-level rules ("own subtasks only") are enforced in the service layer in Phase 3.
- **Access + refresh tokens** with separate secrets and a `type` claim; a refresh token cannot be used as an access token (and vice versa).
- Passwords hashed with **bcryptjs**.

### Auth endpoints
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/login` | public | email+password → `{ accessToken, refreshToken, user }` |
| POST | `/api/auth/refresh` | public | refresh token → new token pair |
| GET  | `/api/auth/me` | Bearer | current user + role |
| GET  | `/api/health` | public | health + user count |

All demo accounts share password **`password123`**.

## Core API (Phase 3)
Every endpoint is role-guarded server-side; list/detail endpoints additionally filter rows by role.

| Area | Endpoints |
|------|-----------|
| Clients | `POST /clients` (CEO), `GET /clients` (CEO/PM), `PATCH :id` (CEO) |
| Projects | `POST` (CEO), `GET` / `GET :id` (role-filtered), `PATCH :id` / `DELETE :id` (CEO) |
| Subtasks | `POST` (PM), `GET` / `GET :id` (own-only for lead/member), `PATCH :id` (PM), `POST :id/team-leads` (PM), `DELETE :id/team-leads/:id` (PM) |
| Assignments | `POST /assignments/team-members` (Lead, own subtasks), `.../reassign` (history-preserving), `DELETE`, `GET` |
| Time entries | `POST` (own assignments), `PATCH :id` / `DELETE :id` (locked once week approved), `GET /week`, `GET /calendar`, `GET /history` (own, selectable range), `GET /deep-search` (scoped to what the role can already see), `POST /timer/start`, `POST /timer/stop` |
| Approvals | `POST /submit` (Member), `POST /approve` / `POST /revert` (PM), `GET /pending` (PM inbox), `GET /status` |
| Edit requests | `POST` (locked-entry owner), `GET /pending` (PM), `POST :id/approve` (reverts week → PENDING), `POST :id/deny` |
| Notifications | `GET` (self), `PATCH :id/read`, `PATCH /read-all` |
| Audit log | `GET /audit-log?entityType=&entityId=` (CEO full, PM operational scope) |
| Users | `GET /users/reviewable` (Reviewing dropdown), `GET /users?role=` (pickers) |

**Enforced rules & state machine:** lock-on-approval (edits only via EditRequest); approving an EditRequest reverts the week's Approval to PENDING and re-opens its entries; assignment history preserved via `assigned_at`/`unassigned_at` (past entries untouched); 15-minute rounding; overtime flagged (never blocked); project hours summaries recomputed on each status change; audit rows written inside the same transaction as each action; notifications fired on every state transition.

Verified via an end-to-end script exercising the full waterfall and every RBAC boundary (**26/26 checks pass**).

## Dashboards (Phase 5 — data endpoints only)
Role-guarded JSON shapes for the charts; rendering is a later task.

| Persona | Endpoint | Shape |
|---------|----------|-------|
| PM | `GET /dashboards/pm/burndown` | per-subtask estimated vs logged hours, days-to-deadline |
| PM | `GET /dashboards/pm/task-status` | Unassigned / Pending / Approved counts + percentages |
| CEO | `GET /dashboards/ceo/resource-allocation` | approved hours grouped by client → project |
| Team Lead | `GET /dashboards/team-lead/hour-distribution` | team hours per assigned subtask, broken down by member |
| Team Member | `GET /dashboards/team-member/hour-distribution` | own hours per subtask |

## Frontend (Phases 6 & 7 — styled, light/dark)
Plain HTML + vanilla JS + a design-system stylesheet (`public/styles.css`), served from `public/` at the site root (API stays under `/api`). No framework — the design system is implemented with CSS custom properties per the spec (the prompt permits plain HTML/CSS in place of Next.js/Tailwind).

- **Design tokens** — the exact blue/slate palette as CSS custom properties, light + dark, toggled via `data-theme` on `<html>`. Flat design (1px borders, 8px/12px radii, no shadows except input focus rings), sentence case, Tabler-style inline-SVG outline icons.
- **Theme toggle** — sun/moon button top-right of the header; persists to a `theme` cookie; defaults to OS `prefers-color-scheme` on first load.
- **`login.html`** — centered ~360px card on the page background, accent primary button, danger-text error area, theme-aware. Stores the JWT in `sessionStorage`; role comes from the JWT.
- **`app.html` + `app.js`** — fixed ~200px sidebar (avatar initials + name + role, CEO-only "+ Add project", Calendar/Table view/Inbox nav with active accent highlight, role-gated "Reviewing" dropdown, Projects list, Log out pinned bottom). Header with breadcrumb + "Weekly timesheet" title + status badge (Draft/Submitted/Approved/Reopened) + theme toggle. Week navigator (‹ / › + range label + Today). Timesheet table: collapsible **project rows** (chevron, accent subtotals) with indented **subtask rows** — inline editable inputs when the week is unlocked & yours, read-only when locked. Cell detail dialog (fade/scale in) with hours, **billable toggle**, notes, and Save/Cancel — or "Request edit" when locked. Styled inbox with icons, relative timestamps, and read/unread dots.

Open `http://localhost:3000` after `npm run start:dev`.

### Role-based pages (every API capability now has UI)
The sidebar nav adapts to the logged-in role; each page calls the already-RBAC-filtered API.

| Role | Pages (beyond Table view / Calendar / Inbox) |
|------|----------------------------------------------|
| CEO | **Projects** (list + delete + Add project), **Clients** (list + create), **Dashboard** (resource allocation, headcount by role, deep search), **Audit log** (entity lookup) |
| PM | **Subtasks** (create + assign/unassign team leads), **Approvals** (timesheet queue approve/reject + edit-request approve/deny), **Dashboard** (task status, burn-down), **Audit log** |
| Team Lead | **My team** (assign/unassign members to own subtasks), **Dashboard** (team hours) |
| Team Member | **My progress** (hours by project → subtask, ranges: 7d / 30d / 6m / custom / lifetime), **Dashboard** (own hour distribution, deep search) |

### User & team administration
Shipped as a dedicated **Admin** role (`Users & teams`): create / edit / deactivate / reactivate / soft-delete users, reset passwords, and promote/demote between Team Member and Team Lead — every action audited. Admins hold no business data and are hidden from all assignment pickers.

## Seeded demo accounts
One user per RBAC tier, all sharing password **`password123`**:
`admin@demo.local`, `ceo@demo.local`, `pm@demo.local`, `lead@demo.local`, `member@demo.local`.

`admin@demo.local` is seeded with `must_change_password = true`, so logging in as Admin exercises the forced set-password screen.
