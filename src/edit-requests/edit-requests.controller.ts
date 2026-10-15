import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { EditRequestsService } from './edit-requests.service';
import { CreateEditRequestDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser, AuthUser } from '../common/current-user.decorator';

@Controller('edit-requests')
export class EditRequestsController {
  constructor(private readonly editRequests: EditRequestsService) {}

  // Any locked-entry owner — every role can log time and thus get locked.
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEditRequestDto) {
    return this.editRequests.create(user, dto);
  }

  @Get('pending')
  @Roles(Role.PM)
  listPending() {
    return this.editRequests.listPending();
  }

  @Post(':id/approve')
  @Roles(Role.PM)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.editRequests.approve(user, id);
  }

  @Post(':id/deny')
  @Roles(Role.PM)
  deny(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.editRequests.deny(user, id);
  }
}
