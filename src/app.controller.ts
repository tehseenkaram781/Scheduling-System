import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { Public } from './common/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  // Public health check that also proves the DB connection works.
  @Public()
  @Get('health')
  async health() {
    const users = await this.prisma.user.count();
    return { status: 'ok', users };
  }
}
