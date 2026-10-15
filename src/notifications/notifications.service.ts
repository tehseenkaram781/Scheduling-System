import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/current-user.decorator';
import { ApprovalsService } from '../approvals/approvals.service';
import { EditRequestsService } from '../edit-requests/edit-requests.service';
import { TaskRequestsService } from '../task-requests/task-requests.service';
import { weekStartOf } from '../common/time.util';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly editRequests: EditRequestsService,
    private readonly taskRequests: TaskRequestsService,
  ) {}

  /**
   * Lists a user's notifications, each enriched with a deep-link target
   * (subject user + week-start) when one applies. SUBMISSION/APPROVAL point at
   * an Approval row; EDIT_REQUEST/EDIT_RESOLVED at an edit request → its entry.
   * Types with no timesheet target keep targetUserId/targetWeekStart null.
   */
  async listForUser(userId: string, unreadOnly: boolean) {
    const notes = await this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { createdAt: 'desc' },
    });

    const approvalIds = new Set<string>();
    const editIds = new Set<string>();
    for (const n of notes) {
      if (!n.relatedEntityId) continue;
      if (n.type === 'SUBMISSION' || n.type === 'APPROVAL') approvalIds.add(n.relatedEntityId);
      else if (n.type === 'EDIT_REQUEST' || n.type === 'EDIT_RESOLVED') editIds.add(n.relatedEntityId);
    }

    const [approvals, edits] = await Promise.all([
      approvalIds.size
        ? this.prisma.approval.findMany({
            where: { id: { in: [...approvalIds] } },
            select: { id: true, userId: true, weekStartDate: true, user: { select: { name: true } } },
          })
        : Promise.resolve([]),
      editIds.size
        ? this.prisma.timeEntryEditRequest.findMany({
            where: { id: { in: [...editIds] } },
            select: {
              id: true,
              timeEntry: { select: { userId: true, date: true, user: { select: { name: true } } } },
            },
          })
        : Promise.resolve([]),
    ]);
    const approvalMap = new Map(approvals.map((a) => [a.id, a] as const));
    const editMap = new Map(edits.map((e) => [e.id, e] as const));

    return notes.map((n) => {
      let targetUserId: string | null = null;
      let targetUserName: string | null = null;
      let targetWeekStart: string | null = null;
      if (n.relatedEntityId) {
        if (n.type === 'SUBMISSION' || n.type === 'APPROVAL') {
          const a = approvalMap.get(n.relatedEntityId);
          if (a) {
            targetUserId = a.userId;
            targetUserName = a.user.name;
            targetWeekStart = a.weekStartDate.toISOString().slice(0, 10);
          }
        } else if (n.type === 'EDIT_REQUEST' || n.type === 'EDIT_RESOLVED') {
          const e = editMap.get(n.relatedEntityId);
          if (e) {
            targetUserId = e.timeEntry.userId;
            targetUserName = e.timeEntry.user.name;
            targetWeekStart = weekStartOf(e.timeEntry.date).toISOString().slice(0, 10);
          }
        }
      }
      // HOURS_ALERT has no entity to join to — the week deliberately has no
      // Approval row yet — so its relatedEntityId IS the week-start date, and
      // the recipient is always the timesheet owner. Deep-links straight to
      // their own Table view for that week.
      if (n.type === 'HOURS_ALERT' && n.relatedEntityId) {
        targetUserId = n.userId;
        targetWeekStart = n.relatedEntityId;
      }
      // Fallback for owner-facing "…for week of YYYY-MM-DD…" messages that carry
      // no relatedEntityId (older rows created before this wiring): the recipient
      // is the timesheet owner, and the week is in the text.
      if (!targetWeekStart && n.type === 'APPROVAL') {
        const m = n.message.match(/week of (\d{4}-\d{2}-\d{2})/);
        if (m) {
          targetUserId = n.userId;
          targetWeekStart = m[1];
        }
      }
      return { ...n, targetUserId, targetUserName, targetWeekStart };
    });
  }

  async markRead(actor: AuthUser, id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundException('Notification not found');
    if (n.userId !== actor.id) throw new ForbiddenException('Not your notification');
    return this.prisma.notification.update({ where: { id }, data: { read: true } });
  }

  async markAllRead(actor: AuthUser) {
    const res = await this.prisma.notification.updateMany({
      where: { userId: actor.id, read: false },
      data: { read: true },
    });
    return { marked: res.count };
  }

  /**
   * Inline quick-action on an actionable notification (SUBMISSION / EDIT_REQUEST).
   * Dispatches to the same service the full-page flow uses, reusing its checks,
   * then marks the notification resolved. 400 if the notification isn't actionable.
   */
  async action(actor: AuthUser, id: string, decision: string, note?: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n) throw new NotFoundException('Notification not found');
    if (n.userId !== actor.id) throw new ForbiddenException('Not your notification');
    if (!n.actionable) throw new BadRequestException('This notification is not actionable');
    if (n.resolved) throw new BadRequestException('This notification is already resolved');
    if (!n.relatedEntityId) throw new BadRequestException('Notification has no related entity');
    // SUBMISSION + EDIT_REQUEST are PM-only (mirrors the full-page guards).
    // TASK_REQUEST is the exception: it is reviewed by the project's Team Lead,
    // never the PM, so its own service enforces the rule instead.
    if (n.type !== 'TASK_REQUEST' && actor.role !== Role.PM) {
      throw new ForbiddenException('Only a PM can action this');
    }

    let result: unknown;
    if (n.type === 'TASK_REQUEST') {
      // 'reject' is the inbox's existing wording for "send it back" — here that
      // means CHANGES_REQUESTED, which keeps the request open for editing.
      const map: Record<string, 'approve' | 'deny' | 'request_changes'> = {
        approve: 'approve',
        deny: 'deny',
        reject: 'request_changes',
      };
      result = await this.taskRequests.review(actor, n.relatedEntityId, {
        decision: map[decision],
        note,
      });
    } else if (n.type === 'SUBMISSION') {
      // related entity is the Approval row.
      const approval = await this.prisma.approval.findUnique({ where: { id: n.relatedEntityId } });
      if (!approval) throw new NotFoundException('Approval not found');
      const weekStart = approval.weekStartDate.toISOString().slice(0, 10);
      result =
        decision === 'approve'
          ? await this.approvals.approve(actor, approval.userId, weekStart)
          : await this.approvals.revert(actor, approval.userId, weekStart);
    } else if (n.type === 'EDIT_REQUEST') {
      result =
        decision === 'approve'
          ? await this.editRequests.approve(actor, n.relatedEntityId)
          : await this.editRequests.deny(actor, n.relatedEntityId);
    } else {
      throw new BadRequestException('Unsupported notification type for quick-action');
    }

    // The dispatched service already resolves related notifications; ensure this one too.
    await this.prisma.notification.update({
      where: { id },
      data: { resolved: true, read: true },
    });
    return { ok: true, decision, result };
  }
}
