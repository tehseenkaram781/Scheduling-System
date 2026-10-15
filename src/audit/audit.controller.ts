import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuditService } from './audit.service';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  // CEO: full access. PM: scoped to operational entities (enforced in service).
  @Get()
  @Roles(Role.CEO, Role.PM)
  forEntity(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    return this.audit.forEntity(user, entityType, entityId);
  }
}
