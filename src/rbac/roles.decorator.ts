import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Action, rolesForAction } from './permissions';

export const ROLES_KEY = 'roles';

/**
 * Restrict an endpoint to specific roles. Two forms:
 *   @Roles(Role.CEO, Role.PM)            — explicit role list
 *   @RequirePermission(Action.CREATE_PROJECT) — pulls the role list from the matrix
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const RequirePermission = (action: Action) =>
  SetMetadata(ROLES_KEY, rolesForAction(action));
