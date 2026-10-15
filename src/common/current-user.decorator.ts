import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { DisplayUnit, Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  // Set on accounts an Admin created / reset — forces the set-new-password screen.
  mustChangePassword?: boolean;
  // Self-service profile picture (data URL) — null/absent falls back to initials.
  // Resolved from the database per request, never carried in the JWT: the token
  // would balloon, and a stale token would keep serving an old picture.
  avatarUrl?: string | null;
  // Display-unit preference, resolved per request for the same reason as the
  // avatar. Affects rendering only — never storage, entry or validation.
  displayUnit?: DisplayUnit;
}

/** Injects the authenticated user (as set by JwtStrategy.validate) into a handler param. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | AuthUser[keyof AuthUser] => {
    const request = ctx.switchToHttp().getRequest();
    const user: AuthUser = request.user;
    return data ? user?.[data] : user;
  },
);
