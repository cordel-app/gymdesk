import { Request, Response, NextFunction } from 'express';
import { db } from './db';
import { getTenantContext } from './tenantContext';

export interface CenterContext {
  /** Selected/active center for this request (from x-center-id), or null = "all centers in gym". */
  centerId: number | null;
  /** For role === 'member': the set of center ids they're assigned to. null for admin/coach/staff (unrestricted). */
  allowedCenterIds: number[] | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      centerCtx?: CenterContext;
    }
  }
}

/**
 * Runs AFTER tenantContext (needs gymId/role/userId). Resolves the caller's
 * center visibility: a `member` is restricted to the centers they're
 * assigned to via member_centers; admin/coach/staff see every center in
 * their gym by default.
 */
export async function centerContext(req: Request, res: Response, next: NextFunction) {
  const { gymId, role, userId } = getTenantContext(req);
  const headerRaw = req.headers['x-center-id'] as string | undefined;
  const headerCenterId = headerRaw ? Number(headerRaw) : null;

  let allowedCenterIds: number[] | null = null;

  if (role === 'member') {
    const { rows } = await db.query<{ center_id: number }>(
      `SELECT mc.center_id FROM member_centers mc
       JOIN members m ON m.id = mc.member_id
       WHERE m.clerk_user_id = ? AND m.gym_id = ? AND mc.deleted_at IS NULL`,
      [userId, gymId],
    );
    allowedCenterIds = rows.map((r) => r.center_id);
    if (headerCenterId != null && !allowedCenterIds.includes(headerCenterId)) {
      return res.status(403).json({ error: 'You are not assigned to this center' });
    }
  } else if (headerCenterId != null) {
    const { rows } = await db.query(
      'SELECT 1 FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [headerCenterId, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Center not found' });
  }

  req.centerCtx = { centerId: headerCenterId, allowedCenterIds };
  next();
}

export function getCenterContext(req: Request): CenterContext {
  if (!req.centerCtx) throw new Error('centerCtx not set — ensure centerContext middleware ran');
  return req.centerCtx;
}

/**
 * Resolves the center_id a write should use: explicit body value > the
 * x-center-id header > the gym's sole active center. Throws {status,message}
 * (status defaults via the caller's error handling) on failure.
 */
export async function resolveCenterId(gymId: string, req: Request, bodyCenterId?: unknown): Promise<number> {
  const { centerId: headerCenterId, allowedCenterIds } = getCenterContext(req);
  const candidate = bodyCenterId != null && bodyCenterId !== '' ? Number(bodyCenterId) : headerCenterId;

  if (candidate != null) {
    const { rows } = await db.query(
      'SELECT 1 FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [candidate, gymId],
    );
    if (rows.length === 0) throw Object.assign(new Error('center_id not found for this gym'), { status: 400 });
    if (allowedCenterIds && !allowedCenterIds.includes(candidate)) {
      throw Object.assign(new Error('You are not assigned to this center'), { status: 403 });
    }
    return candidate;
  }

  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL',
    [gymId],
  );
  if (rows.length === 1) return rows[0].id;
  throw Object.assign(new Error('center_id is required — this gym has multiple centers'), { status: 400 });
}
