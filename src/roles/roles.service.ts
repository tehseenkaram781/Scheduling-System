import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { writeAudit } from '../common/audit.util';
import { notify } from '../common/notify.util';
import { RoleChangeDto } from './dto';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * PM-only role change, restricted to the Member <-> Lead tiers only.
   * Writes RoleChangeLog + AuditLog and notifies the affected user, all atomically.
   * Demotion does NOT auto-delete teams/reassign subtasks (per spec) — those stay
   * intact and must be reassigned by the PM separately.
   */
  private async changeRole(actor: AuthUser, dto: RoleChangeDto, from: Role, to: Role, verb: string) {
    const target = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!target) throw new NotFoundException('User not found');
    if (target.role !== from) {
      throw new BadRequestException(`User is not a ${from}; cannot ${verb.toLowerCase()}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: dto.userId },
        data: { role: to },
      });
      const log = await tx.roleChangeLog.create({
        data: {
          userId: dto.userId,
          oldRole: from,
          newRole: to,
          changedById: actor.id,
          reason: dto.reason ?? null,
        },
      });
      // Also written to the unified AuditLog timeline.
      await writeAudit(tx, {
        actorId: actor.id,
        action: `ROLE_${verb.toUpperCase()}`,
        entityType: 'User',
        entityId: dto.userId,
        oldValue: { role: from },
        newValue: { role: to, roleChangeLogId: log.id },
      });
      // Notification trigger: Promoted/Demoted → affected user
      await notify(tx, {
        userId: dto.userId,
        type: 'ROLE_CHANGE',
        message: `You were ${verb.toLowerCase()} from ${from.replace('_', ' ')} to ${to.replace('_', ' ')}`,
        relatedEntityId: dto.userId,
      });
      return { user: { id: updated.id, name: updated.name, role: updated.role }, log };
    });
  }

  promote(actor: AuthUser, dto: RoleChangeDto) {
    return this.changeRole(actor, dto, Role.TEAM_MEMBER, Role.TEAM_LEAD, 'Promoted');
  }

  demote(actor: AuthUser, dto: RoleChangeDto) {
    return this.changeRole(actor, dto, Role.TEAM_LEAD, Role.TEAM_MEMBER, 'Demoted');
  }

  /** Promotion/demotion history for one user (queryable on its own, per spec). */
  history(userId: string) {
    return this.prisma.roleChangeLog.findMany({
      where: { userId },
      include: { changedBy: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
