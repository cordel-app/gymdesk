import { createClerkClient } from '@clerk/backend';
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
import { Request, Response, NextFunction } from 'express';
import { db } from './db';

export type GymRole = 'admin' | 'coach' | 'staff' | 'member';

export interface TenantContext {
  userId: string;
  gymId: string;
  role: GymRole;
  /** gym_memberships.id for this user in this gym, or null for superadmins with no membership row. */
  gymMembershipId: number | null;
  /** Platform superadmin (Clerk publicMetadata.platform_role), distinct from a gym-level admin. */
  isSuperadmin: boolean;
  /** Display name captured from Clerk at request time — used for immutable audit snapshots. */
  actorName: string | null;
  /** Set when a superadmin is impersonating another user. */
  impersonatedUserId?: string;
  impersonatedActorName?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantCtx?: TenantContext;
      /** Set by requireAuth() in app.ts after verifying the JWT. */
      auth?: { userId: string };
    }
  }
}

export async function tenantContext(req: Request, res: Response, next: NextFunction) {
  const userId = req.auth?.userId;
  const gymId = req.headers['x-gym-id'] as string | undefined;

  if (!userId || !gymId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Superadmins get full admin access to any gym without a membership row
  const user = await clerkClient.users.getUser(userId);
  const meta = (user.publicMetadata ?? {}) as Record<string, unknown>;
  const actorName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || null;

  if (meta.platform_role === 'superadmin') {
    const impersonateAs = req.headers['x-impersonate-as'] as string | undefined;

    if (impersonateAs && impersonateAs !== userId) {
      // Validate the target user has an active membership in this gym
      const { rows: targetRows } = await db.query<{ id: number; role: GymRole }>(
        `SELECT gm.id, gm.role FROM gym_memberships gm
         JOIN gyms g ON g.id = gm.gym_id
         WHERE gm.user_id = ? AND gm.gym_id = ?
           AND (g.deleted_at IS NULL OR g.deleted_at > UTC_TIMESTAMP())`,
        [impersonateAs, gymId],
      );

      if (!targetRows[0]) {
        return res.status(400).json({ error: 'Impersonation target has no active membership in this gym' });
      }

      let impersonatedActorName: string | null = null;
      try {
        const targetClerkUser = await clerkClient.users.getUser(impersonateAs);
        // Prevent impersonating another superadmin
        if ((targetClerkUser.publicMetadata as any)?.platform_role === 'superadmin') {
          return res.status(400).json({ error: 'Cannot impersonate another superadmin' });
        }
        impersonatedActorName = targetClerkUser.fullName
          || [targetClerkUser.firstName, targetClerkUser.lastName].filter(Boolean).join(' ')
          || null;
      } catch {
        return res.status(400).json({ error: 'Impersonation target not found' });
      }

      req.tenantCtx = {
        userId,
        gymId,
        role: targetRows[0].role,
        gymMembershipId: targetRows[0].id,
        isSuperadmin: true,
        actorName,
        impersonatedUserId: impersonateAs,
        impersonatedActorName,
      };
      return next();
    }

    req.tenantCtx = { userId, gymId, role: 'admin', gymMembershipId: null, isSuperadmin: true, actorName };
    return next();
  }

  const { rows } = await db.query<{ id: number; role: GymRole }>(
    'SELECT id, role FROM gym_memberships WHERE user_id = ? AND gym_id = ?',
    [userId, gymId],
  );

  if (!rows[0]) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.tenantCtx = { userId, gymId, role: rows[0].role, gymMembershipId: rows[0].id, isSuperadmin: false, actorName };
  next();
}

export function getTenantContext(req: Request): TenantContext {
  if (!req.tenantCtx) throw new Error('tenantCtx not set — ensure tenantContext middleware ran');
  return req.tenantCtx;
}

export function requireRole(...roles: GymRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenantCtx || !roles.includes(req.tenantCtx.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

export async function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = await clerkClient.users.getUser(userId);
  const meta = (user.publicMetadata ?? {}) as Record<string, unknown>;
  if (meta.platform_role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
