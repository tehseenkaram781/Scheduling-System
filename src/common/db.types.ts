import { Prisma } from '@prisma/client';

/**
 * Anything that can run model queries: the root PrismaService or a transaction
 * client from `prisma.$transaction`. Helpers accept this so audit/notification
 * writes can join the same transaction as the action they record.
 */
export type Db = Prisma.TransactionClient;
