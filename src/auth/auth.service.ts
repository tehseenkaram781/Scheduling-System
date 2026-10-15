import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from '../common/hash.util';
import { AuthUser } from '../common/current-user.decorator';
import { JwtPayload } from './jwt.strategy';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // A soft-deleted account behaves as if it never existed (same as bad creds).
    if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
      // Same message for these cases — do not leak which emails exist.
      throw new UnauthorizedException('Invalid credentials');
    }
    // Deactivated accounts get a distinct message (the owner knows the account exists).
    if (user.deactivatedAt) {
      throw new UnauthorizedException('This account has been deactivated. Contact your administrator.');
    }
    return this.issueTokens(user);
  }

  /** Self-service password change — clears the forced-change flag on success. */
  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new UnauthorizedException('New password must be at least 8 characters');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User no longer exists');
    // If the caller supplied the current password, verify it (defence in depth).
    if (currentPassword && !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    return { ok: true };
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return this.issueTokens(user);
  }

  private async issueTokens(user: User) {
    const base: JwtPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { ...base, type: 'access' },
        {
          secret: this.config.getOrThrow<string>('JWT_SECRET'),
          expiresIn: this.config.getOrThrow<string>('JWT_EXPIRES_IN'),
        } as JwtSignOptions,
      ),
      this.jwt.signAsync(
        { ...base, type: 'refresh' },
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: this.config.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN'),
        } as JwtSignOptions,
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        avatarUrl: user.avatarUrl,
        displayUnit: user.displayUnit,
      },
    };
  }

  async currentUser(id: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      avatarUrl: user.avatarUrl,
      displayUnit: user.displayUnit,
    };
  }
}
