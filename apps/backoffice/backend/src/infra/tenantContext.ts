import { getAuth, clerkClient } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';
import { db } from './db';

export type GymRole = 'admin' | 'coach' | 'staff';

export interface TenantContext {
  userId: string;
  gymId: string;
  role: GymRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      tenantCtx?: TenantContext;
    }
  }
}

export async function tenantContext(req: Request, res: Response, next: NextFunction) {
  const userId = getAuth(req).userId;
  const gymId = req.headers['x-gym-id'] as string | undefined;

  if (!userId || !gymId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { rows } = await db.query<{ role: GymRole }>(
    'SELECT role FROM gym_memberships WHERE user_id = $1 AND gym_id = $2',
    [userId, gymId],
  );

  if (!rows[0]) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  req.tenantCtx = { userId, gymId, role: rows[0].role };
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
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = await clerkClient.users.getUser(userId);
  const meta = (user.publicMetadata ?? {}) as Record<string, unknown>;
  if (meta.platform_role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
