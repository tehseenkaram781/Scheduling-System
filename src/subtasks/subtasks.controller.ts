import {
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
import { SubtasksService } from './subtasks.service';
import { CreateSubtaskDto, UpdateSubtaskDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('subtasks')
export class SubtasksController {
  constructor(private readonly subtasks: SubtasksService) {}

  @Post()
  @Roles(Role.PM)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSubtaskDto) {
    return this.subtasks.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string) {
    return this.subtasks.list(user, projectId);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subtasks.findOne(user, id);
  }

  @Patch(':id')
  @Roles(Role.PM)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateSubtaskDto) {
    return this.subtasks.update(user, id, dto);
  }

  // Delete-impact summary (logged hours + people) for the confirmation dialog.
  @Get(':id/usage')
  @Roles(Role.PM)
  usage(@Param('id') id: string) {
    return this.subtasks.usage(id);
  }

  @Delete(':id')
  @Roles(Role.PM)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subtasks.remove(user, id);
  }
}
