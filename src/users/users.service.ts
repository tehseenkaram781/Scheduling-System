import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify } from '../common/notify.util';
import { hashPassword } from '../common/hash.util';
import { CreateUserDto, ResetPasswordDto, UpdateMeDto, UpdateUserDto } from './dto';

const PUBLIC_SELECT = { id: true, name: true, email: true, role: true } as const;

// Fields the Admin panel needs (never includes the password hash).
const ADMIN_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  mustChangePassword: true,
  deactivatedAt: true,
  deletedAt: true,
  createdAt: true,
} as const;

// Everywhere a business picker/dropdown lists users, soft-deleted accounts are
// hidden app-wide (per the delete-user rule). Admins never appear either — they
// hold no business data and are not reviewable/assignable.
const VISIBLE = { deletedAt: null, role: { not: Role.ADMIN } } as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Who the current user may review (the "Reviewing" dropdown):
   *  - CEO: everyone (minus Admins)
   *  - PM: all Team Leads + Team Members
   *  - Team Lead: own Team Members only
   *  - Team Member: no dropdown (empty)
   */
  async reviewable(viewer: AuthUser) {
    if (viewer.role === Role.CEO) {
      return this.prisma.user.findMany({
        where: VISIBLE,
        select: PUBLIC_SELECT,
        orderBy: { name: 'asc' },
      });
    }
    if (viewer.role === Role.PM) {
      return this.prisma.user.findMany({
        where: { ...VISIBLE, role: { in: [Role.TEAM_LEAD, Role.TEAM_MEMBER] } },
        select: PUBLIC_SELECT,
        orderBy: { name: 'asc' },
      });
    }
    if (viewer.role === Role.TEAM_LEAD) {
      return this.prisma.user.findMany({
        where: {
          ...VISIBLE,
          role: Role.TEAM_MEMBER,
          teamMemberAssignments: {
            some: { subtask: { project: { teamLeadId: viewer.id } } },
          },
        },
        select: PUBLIC_SELECT,
        orderBy: { name: 'asc' },
        distinct: ['id'],
      });
    }
    return [];
  }

  /** Role-filtered directory used by assignment pickers (PM → leads, Lead → members). */
  /**
   * `unassignedOnly` narrows the list to users with no active membership on any
   * live team — used by the "Add member" picker so a lead is never offered
   * someone who already belongs to another team (a rule the Teams service also
   * enforces independently on write).
   */
  listByRole(role?: Role, unassignedOnly = false) {
    const where: Prisma.UserWhereInput = role ? { ...VISIBLE, role } : { ...VISIBLE };
    if (unassignedOnly) {
      where.teamMemberships = { none: { removedAt: null, team: { deletedAt: null } } };
    }
    return this.prisma.user.findMany({
      where,
      select: PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  // =========================================================================
  // Admin-only account lifecycle (all writes audited; actor = the Admin).
  // =========================================================================

  /** Full user list for the Admin panel — includes deactivated + deleted, with status. */
  listAll() {
    return this.prisma.user.findMany({
      where: {},
      select: ADMIN_SELECT,
      orderBy: [{ deletedAt: 'asc' }, { name: 'asc' }],
    });
  }

  async createUser(actor: AuthUser, dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('A user with that email already exists');

    const passwordHash = await hashPassword(dto.password);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          role: dto.role,
          passwordHash,
          createdById: actor.id,
          mustChangePassword: true,
        },
        select: ADMIN_SELECT,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'USER_CREATED',
        entityType: 'User',
        entityId: created.id,
        newValue: { name: created.name, email: created.email, role: created.role },
      });
      // Informational heads-up to the new user (not actionable — no in-app buttons).
      await notify(tx, {
        userId: created.id,
        type: 'ACCOUNT',
        message: `Your account was created. You'll be asked to set a new password on first login.`,
        relatedEntityId: created.id,
      });
      return created;
    });
  }

  async updateUser(actor: AuthUser, id: string, dto: UpdateUserDto) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('User not found');
    if (dto.email && dto.email !== target.email) {
      const clash = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (clash) throw new ConflictException('A user with that email already exists');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          name: dto.name ?? undefined,
          email: dto.email ?? undefined,
          role: dto.role ?? undefined,
        },
        select: ADMIN_SELECT,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'USER_UPDATED',
        entityType: 'User',
        entityId: id,
        oldValue: { name: target.name, email: target.email, role: target.role },
        newValue: { name: updated.name, email: updated.email, role: updated.role },
      });
      return updated;
    });
  }

  /**
   * Self-service profile edit — the Profile Settings dropdown.
   *
   * Always writes to `actor.id`; there is no id parameter, so a user can only
   * ever edit themselves regardless of what they put in the body. Scope is
   * display name + picture only (UpdateMeDto has no email/role), so this stays
   * clear of the Admin-only identity and permission fields.
   *
   * Per spec there is no conflict handling against a concurrent Admin edit of
   * the same name — last write wins.
   */
  async updateMe(actor: AuthUser, dto: UpdateMeDto) {
    const me = await this.prisma.user.findUnique({ where: { id: actor.id } });
    if (!me || me.deletedAt) throw new NotFoundException('User not found');
    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) throw new BadRequestException('Name cannot be empty');
    // `undefined` = field absent, leave as-is. `null` = explicit "remove my
    // picture", which must reach Prisma as null, not be treated as absent.
    const avatarUrl = dto.avatarUrl === undefined ? undefined : (dto.avatarUrl || null);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: actor.id },
        data: { name: name ?? undefined, avatarUrl, displayUnit: dto.displayUnit ?? undefined },
        select: { id: true, name: true, email: true, role: true, avatarUrl: true, displayUnit: true },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'PROFILE_UPDATED',
        entityType: 'User',
        entityId: actor.id,
        // Avatar payloads are tens of KB — log only whether one is set, so the
        // audit table doesn't accumulate a copy of every image ever uploaded.
        oldValue: { name: me.name, hasAvatar: !!me.avatarUrl, displayUnit: me.displayUnit },
        newValue: { name: updated.name, hasAvatar: !!updated.avatarUrl, displayUnit: updated.displayUnit },
      });
      return updated;
    });
  }

  async resetPassword(actor: AuthUser, id: string, dto: ResetPasswordDto) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('User not found');
    const passwordHash = await hashPassword(dto.password);
    return this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true },
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'USER_PASSWORD_RESET',
        entityType: 'User',
        entityId: id,
      });
      await notify(tx, {
        userId: id,
        type: 'ACCOUNT',
        message: `Your password was reset by an administrator. You'll set a new one on next login.`,
        relatedEntityId: id,
      });
      return { ok: true };
    });
  }

  async setActive(actor: AuthUser, id: string, active: boolean) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('User not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { deactivatedAt: active ? null : new Date() },
        select: ADMIN_SELECT,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
        entityType: 'User',
        entityId: id,
      });
      return updated;
    });
  }

  /**
   * Soft-delete (Admin). Blocked if it would leave a team leaderless unless the
   * Admin confirms — same warning pattern as demoting a Team Lead.
   */
  async deleteUser(actor: AuthUser, id: string, confirm: boolean) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target || target.deletedAt) throw new NotFoundException('User not found');

    const ledTeams = await this.prisma.team.findMany({
      where: { teamLeadId: id, deletedAt: null },
      select: { name: true },
    });
    if (ledTeams.length && !confirm) {
      throw new ConflictException(
        `This user leads ${ledTeams.length} team(s): ${ledTeams
          .map((t) => t.name)
          .join(', ')}. Deleting them leaves those teams leaderless until reassigned. Re-send with confirm=true to proceed.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.user.update({
        where: { id },
        data: { deletedAt: new Date() },
        select: ADMIN_SELECT,
      });
      await writeAudit(tx, {
        actorId: actor.id,
        action: 'USER_DELETED',
        entityType: 'User',
        entityId: id,
        oldValue: { name: target.name, email: target.email, role: target.role },
      });
      return deleted;
    });
  }
}
