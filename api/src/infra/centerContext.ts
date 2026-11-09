import { Request, Response, NextFunction } from 'express';
import { db } from './db';
import { getTenantContext } from './tenantContext';

export interface CenterContext {
  /** Selected/active center for this request (from x-center-id), or null = "all centers in gym". */
  centerId: number | null;
  /**
   * Always null: no role is restricted to "assigned" centers any more (#2383 removed
   * that concept; which centers a member may *use* is their plans' center access).
   */
  allowedCenterIds: number[] | null;
  /** For role === 'member': their default center (member_centers.is_default), else null. */
  defaultCenterId: number | null;
}

/**
 * The center a write defaults to when the caller names none: the gym's only
 * active center, or null when it has none or several. Inactive centers don't
 * count — a gym with one active and one inactive center is a single-center gym
 * for defaulting purposes, and nobody should be defaulted into a closed center.
 */
export async function soleActiveCenterId(gymId: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    "SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL AND status = 'active' LIMIT 2",
    [gymId],
  );
  return rows.length === 1 ? rows[0].id : null;
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
  const { gymId, role, userId, effectiveUserId, effectiveType } = getTenantContext(req);
  const headerRaw = req.headers['x-center-id'] as string | undefined;
  const headerCenterId = headerRaw ? Number(headerRaw) : null;

  let defaultCenterId: number | null = null;

  // #1985 / #2383: a member is not restricted to "assigned" centers — every
  // future event of the gym is visible to them. Their default center is only
  // the default *filter* of the calendar and My Bookings when no center is named.
  if (role === 'member') {
    // Under member impersonation, effectiveUserId is members.id, not a Clerk
    // user id — match on the member row directly.
    const { rows } = effectiveType === 'member'
      ? await db.query<{ center_id: number }>(
          `SELECT mc.center_id FROM member_centers mc
           JOIN members m ON m.id = mc.member_id
           WHERE m.id = ? AND m.gym_id = ? AND mc.deleted_at IS NULL AND mc.is_default = 1
           LIMIT 1`,
          [Number(effectiveUserId), gymId],
        )
      : await db.query<{ center_id: number }>(
          `SELECT mc.center_id FROM member_centers mc
           JOIN members m ON m.id = mc.member_id
           WHERE m.clerk_user_id = ? AND m.gym_id = ? AND mc.deleted_at IS NULL AND mc.is_default = 1
           LIMIT 1`,
          [userId, gymId],
        );
    defaultCenterId = rows[0]?.center_id ?? null;
  }

  if (headerCenterId != null) {
    const { rows } = await db.query(
      'SELECT 1 FROM centers WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
      [headerCenterId, gymId],
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Center not found' });
  }

  const allowedCenterIds: number[] | null = null;
  req.centerCtx = { centerId: headerCenterId, allowedCenterIds, defaultCenterId };
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

  const soleId = await soleActiveCenterId(gymId);
  if (soleId != null) return soleId;
  throw Object.assign(new Error('center_id is required as the gym has more than one center'), { status: 400 });
}
