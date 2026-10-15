import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { writeAudit } from '../common/audit.util';
import { CreateClientDto, UpdateClientDto } from './dto';

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(actorId: string, dto: CreateClientDto) {
    return this.prisma.$transaction(async (tx) => {
      const client = await tx.client.create({ data: { name: dto.name } });
      await writeAudit(tx, {
        actorId,
        action: 'CLIENT_CREATED',
        entityType: 'Client',
        entityId: client.id,
        newValue: client,
      });
      return client;
    });
  }

  /** Edit a client (CEO). A client is just a name that projects hang off of. */
  async update(actorId: string, id: string, dto: UpdateClientDto) {
    const existing = await this.prisma.client.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Client not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.client.update({
        where: { id },
        data: { name: dto.name ?? undefined },
      });
      await writeAudit(tx, {
        actorId,
        action: 'CLIENT_UPDATED',
        entityType: 'Client',
        entityId: id,
        oldValue: existing,
        newValue: updated,
      });
      return updated;
    });
  }

  list() {
    return this.prisma.client.findMany({ orderBy: { name: 'asc' } });
  }
}
