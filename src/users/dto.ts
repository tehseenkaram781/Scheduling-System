import { IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DisplayUnit, Role } from '@prisma/client';

/**
 * Hard ceiling on the stored avatar string. The client downscales to 256px and
 * re-encodes as JPEG (typically 10–30KB base64), so this is roughly 8× headroom
 * — generous enough never to reject a legitimate upload, tight enough that a
 * crafted payload can't bloat the row or the response of every /users query.
 */
export const MAX_AVATAR_CHARS = 250_000;

export class CreateUserDto {
  @IsString()
  name: string;

  @IsEmail()
  email: string;

  @IsEnum(Role)
  role: Role;

  // Initial password set by the Admin — the user is forced to change it on first login.
  @IsString()
  @MinLength(8)
  password: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  // Direct role set (distinct from the PM promote/demote flow) — Admin only.
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  password: string;
}

/**
 * Self-service profile edit (PATCH /users/me). Deliberately narrower than
 * UpdateUserDto: a user may change their own display name and picture, never
 * their email or role — those stay Admin-only, so this endpoint can't be used
 * to escalate a role or hijack an identity.
 *
 * Every field is optional so the dropdown can save just one of them.
 * `avatarUrl: null` clears the picture and reverts to the initials fallback.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @MaxLength(MAX_AVATAR_CHARS)
  // Only inline images — a remote URL here would turn every avatar render into
  // an outbound request to an address the user chose (an SSRF / tracking-pixel
  // vector), and `javascript:` / `data:text/html` would be an XSS vector.
  @Matches(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, {
    message: 'avatarUrl must be an inline PNG, JPEG or WebP data URL',
  })
  avatarUrl?: string | null;

  /**
   * Display-unit preference. Purely a rendering choice — it does not change
   * what is stored (hours), what is accepted on entry (HH:MM), or any cap.
   * Enum-validated so the column can only ever hold a value the client knows
   * how to render.
   */
  @IsOptional()
  @IsEnum(DisplayUnit)
  displayUnit?: DisplayUnit;
}
