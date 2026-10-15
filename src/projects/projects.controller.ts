import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, SetProjectLeadDto, UpdateProjectDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @Roles(Role.CEO)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user, dto);
  }

  // Any authenticated role — results are filtered server-side per role.
  // ?include_archived=true also returns soft-archived projects.
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('include_archived') includeArchived?: string) {
    return this.projects.list(user, includeArchived === 'true');
  }

  // Archive / unarchive — CEO or PM.
  @Post(':id/archive')
  @Roles(Role.CEO, Role.PM)
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.setArchived(user, id, true);
  }

  @Post(':id/unarchive')
  @Roles(Role.CEO, Role.PM)
  unarchive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.setArchived(user, id, false);
  }

  // Assign / change / clear the project's Team Lead — PM only (v6).
  @Put(':id/lead')
  @Roles(Role.PM)
  setLead(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetProjectLeadDto) {
    return this.projects.setLead(user, id, dto);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.findOne(user, id);
  }

  @Patch(':id')
  @Roles(Role.CEO)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.projects.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(Role.CEO)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projects.remove(user, id);
  }
}
