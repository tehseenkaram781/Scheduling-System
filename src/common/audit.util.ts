import { Prisma } from '@prisma/client';
import { Db } from './db.types';

export interface AuditInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Writes an AuditLog row. MUST be called with the same transaction client as the
 * action being logged so there are no gaps (per the master prompt's rule).
 */
export function writeAudit(tx: Db, input: AuditInput) {
  return tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      oldValue: (input.oldValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      newValue: (input.newValue ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  });
}
