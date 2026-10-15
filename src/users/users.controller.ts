import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto, ResetPasswordDto, UpdateMeDto, UpdateUserDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

// ADMIN must be listed explicitly — RolesGuard denies it on anything that
// doesn't name it, and an Admin still has their own profile to edit.
const ALL_ROLES = [Role.ADMIN, Role.CEO, Role.PM, Role.TEAM_LEAD, Role.TEAM_MEMBER];

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Populates the role-appropriate "Reviewing" dropdown.
  @Get('reviewable')
  reviewable(@CurrentUser() user: AuthUser) {
    return this.users.reviewable(user);
  }

  // Self-service profile (name + picture). Takes no id — the service always
  // writes to the authenticated user, so this can't be aimed at someone else.
  @Patch('me')
  @Roles(...ALL_ROLES)
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(user, dto);
  }

  // -------------------------------------------------------------------------
  // Admin-only user management (Phase 3 #15). All reject non-ADMIN with 403.
  // Placed before the ":id"-free GET so /users/admin doesn't collide.
  // -------------------------------------------------------------------------

  @Get('admin')
  @Roles(Role.ADMIN)
  listAll() {
    return this.users.listAll();
  }

  @Post('admin')
  @Roles(Role.ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.createUser(user, dto);
  }

  @Patch('admin/:id')
  @Roles(Role.ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.updateUser(user, id, dto);
  }

  @Post('admin/:id/reset-password')
  @Roles(Role.ADMIN)
  resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.users.resetPassword(user, id, dto);
  }

  @Post('admin/:id/deactivate')
  @Roles(Role.ADMIN)
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.setActive(user, id, false);
  }

  @Post('admin/:id/reactivate')
  @Roles(Role.ADMIN)
  reactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.setActive(user, id, true);
  }

  @Delete('admin/:id')
  @Roles(Role.ADMIN)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('confirm') confirm?: string,
  ) {
    return this.users.deleteUser(user, id, confirm === 'true');
  }

  // Directory for assignment pickers (also used by the Admin add-team lead select).
  @Get()
  @Roles(Role.CEO, Role.PM, Role.TEAM_LEAD, Role.ADMIN)
  list(@Query('role') role?: string, @Query('unassigned') unassigned?: string) {
    if (role && !Object.values(Role).includes(role as Role)) {
      throw new BadRequestException('Invalid role filter');
    }
    return this.users.listByRole(role as Role | undefined, unassigned === 'true');
  }
}
