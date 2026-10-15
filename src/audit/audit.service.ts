import { ForbiddenException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';

// Entity types a PM may inspect (operational scope). CEO sees everything.
const PM_VISIBLE_ENTITY_TYPES = new Set([
  'Project',
  'Subtask',
  'ProjectTeamLeadAssignment',
  'SubtaskTeamMemberAssignment',
  'TimeEntry',
  'TimeEntryEditRequest',
  'Approval',
]);

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async forEntity(viewer: AuthUser, entityType: string, entityId: string) {
    if (viewer.role !== Role.CEO && viewer.role !== Role.PM) {
      throw new ForbiddenException('Audit log access is limited to CEO and PM');
    }
    if (viewer.role === Role.PM && !PM_VISIBLE_ENTITY_TYPES.has(entityType)) {
      throw new ForbiddenException('PMs may only view operational entity audit logs');
    }
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      include: { actor: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
