import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { RolesService } from './roles.service';
import { RoleChangeDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

// NOTE: path is /role-changes to avoid colliding with the RBAC @Roles decorator concept.
@Controller('role-changes')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Post('promote')
  @Roles(Role.PM)
  promote(@CurrentUser() user: AuthUser, @Body() dto: RoleChangeDto) {
    return this.roles.promote(user, dto);
  }

  @Post('demote')
  @Roles(Role.PM)
  demote(@CurrentUser() user: AuthUser, @Body() dto: RoleChangeDto) {
    return this.roles.demote(user, dto);
  }

  @Get(':userId/history')
  @Roles(Role.CEO, Role.PM)
  history(@Param('userId') userId: string) {
    return this.roles.history(userId);
  }
}
