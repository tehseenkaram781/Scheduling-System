import { NotificationType } from '@prisma/client';
import { Db } from './db.types';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  message: string;
  relatedEntityId?: string;
  // Actionable notifications (SUBMISSION, EDIT_REQUEST) expose inline approve/deny
  // buttons and accept POST /notifications/:id/action.
  actionable?: boolean;
}

/** Creates a Notification row. Pass a tx client to fire it atomically with a state change. */
export function notify(tx: Db, input: NotifyInput) {
  return tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      message: input.message,
      relatedEntityId: input.relatedEntityId ?? null,
      actionable: input.actionable ?? false,
    },
  });
}

/** Convenience: notify every user of a given role (e.g. all PMs on project creation). */
export async function notifyRole(
  tx: Db,
  role: import('@prisma/client').Role,
  input: Omit<NotifyInput, 'userId'>,
) {
  const users = await tx.user.findMany({ where: { role }, select: { id: true } });
  await Promise.all(users.map((u) => notify(tx, { ...input, userId: u.id })));
}
