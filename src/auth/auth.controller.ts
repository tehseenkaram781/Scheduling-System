import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from '../common/public.decorator';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

// Every role, ADMIN included — used to whitelist ADMIN on shared auth endpoints
// (the RolesGuard denies ADMIN by default on anything not explicitly listing it).
const ALL_ROLES = [
  Role.ADMIN,
  Role.CEO,
  Role.PM,
  Role.TEAM_LEAD,
  Role.TEAM_MEMBER,
];

class ChangePasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  // Requires a valid access token (global JwtAuthGuard). Returns current user + role.
  @Get('me')
  @Roles(...ALL_ROLES)
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  // Self-service password change (any authenticated role, incl. the forced
  // first-login change). Clears must_change_password on success.
  @Post('change-password')
  @Roles(...ALL_ROLES)
  @HttpCode(HttpStatus.OK)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }
}
