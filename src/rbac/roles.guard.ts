import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from './roles.decorator';

/**
 * Enforces role-level authorization server-side. Runs after JwtAuthGuard, so
 * `request.user` is guaranteed present for protected routes. Endpoints with no
 * @Roles metadata are allowed for any authenticated user.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const { user } = context.switchToHttp().getRequest();

    // ADMIN is a system role with zero business-data access. Invert the default:
    // it may ONLY reach endpoints that explicitly whitelist ADMIN via @Roles.
    // Every ungated business endpoint (open to any authenticated user) is therefore
    // denied — the same rejection any other unauthorized role would get.
    if (user?.role === Role.ADMIN) {
      if (requiredRoles?.includes(Role.ADMIN)) {
        return true;
      }
      throw new ForbiddenException('Admin has no access to business data');
    }

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }
    return true;
  }
}
