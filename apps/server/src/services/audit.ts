import { auditLog } from '@supops/db';
import type { AuthUser } from '../auth.ts';
import { db } from '../context.ts';

/**
 * Record a change to something that governs what agents may do. Never throws: a
 * failed audit write must not turn a successful change into an error response.
 */
export function audit(
  user: AuthUser | undefined,
  entry: { projectId?: string | null; entity: string; entityId?: string | null; action: string; before?: unknown; after?: unknown },
): void {
  try {
    db.insert(auditLog)
      .values({
        actorId: user?.id ?? null,
        actorName: user?.name ?? null,
        projectId: entry.projectId ?? null,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        action: entry.action,
        before: entry.before ?? null,
        after: entry.after ?? null,
      })
      .run();
  } catch (err) {
    console.error('audit write failed:', err);
  }
}
