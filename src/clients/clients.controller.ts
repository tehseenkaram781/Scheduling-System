import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ClientsService } from './clients.service';
import { CreateClientDto, UpdateClientDto } from './dto';
import { Roles } from '../rbac/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  // Clients group projects by customer — CEO manages them.
  @Post()
  @Roles(Role.CEO)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateClientDto) {
    return this.clients.create(userId, dto);
  }

  @Get()
  @Roles(Role.CEO, Role.PM)
  list() {
    return this.clients.list();
  }

  @Patch(':id')
  @Roles(Role.CEO)
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateClientDto) {
    return this.clients.update(userId, id, dto);
  }
}
