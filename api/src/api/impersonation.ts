import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { getTenantContext, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';
import { db } from '../infra/db';

export const impersonationRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

/**
 * POST /platform/impersonation/:userId
 * Superadmin-only. Validates the target, records ImpersonationStarted, and returns
 * the effective user's data for the frontend banner and role override.
 */
impersonationRouter.post('/:userId', requireSuperadmin, async (req, res, next) => {
  const { userId: adminId } = getTenantContext(req);
  const targetId = String(req.params.userId);
  const gymId = req.headers['x-gym-id'] as string | undefined;

  if (!gymId) return res.status(400).json({ error: 'x-gym-id header required' });
  if (targetId === adminId) return res.status(400).json({ error: 'Cannot impersonate yourself' });

  try {
    const targetUser = await clerkClient.users.getUser(targetId).catch(() => null);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if ((targetUser.publicMetadata as any)?.platform_role === 'superadmin') {
      return res.status(400).json({ error: 'Cannot impersonate another superadmin' });
    }

    const { rows } = await db.query<{ id: number; role: string }>(
      `SELECT gm.id, gm.role FROM gym_memberships gm
       WHERE gm.user_id = ? AND gm.gym_id = ?`,
      [targetId, gymId],
    );

    if (!rows[0]) {
      return res.status(400).json({ error: 'Target user has no membership in this gym' });
    }

    const primaryEmail = targetUser.emailAddresses?.find(
      (e: any) => e.id === targetUser.primaryEmailAddressId,
    ) ?? targetUser.emailAddresses?.[0];

    const targetName =
      targetUser.fullName ||
      [targetUser.firstName, targetUser.lastName].filter(Boolean).join(' ') ||
      primaryEmail?.emailAddress ||
      targetId;

    recordAudit(req, {
      action: 'impersonation_started',
      entityType: 'gym_user',
      entityId: targetId,
      entityName: targetName,
      next: {
        impersonated_user_id: targetId,
        impersonated_user_name: targetName,
        impersonated_role: rows[0].role,
        gym_id: gymId,
      },
    });

    res.json({
      id: targetId,
      name: targetName,
      role: rows[0].role,
      gym_id: gymId,
    });
  } catch (err) { next(err); }
});

/**
 * POST /platform/impersonation/stop
 * Records ImpersonationEnded. The frontend passes the target user's info and
 * optional duration so the audit entry is self-contained.
 */
impersonationRouter.post('/stop', requireSuperadmin, async (req, res, next) => {
  const { impersonated_user_id, impersonated_user_name, impersonated_role, duration_seconds } = req.body ?? {};

  if (!impersonated_user_id) return res.status(400).json({ error: 'impersonated_user_id required' });

  try {
    recordAudit(req, {
      action: 'impersonation_ended',
      entityType: 'gym_user',
      entityId: impersonated_user_id,
      entityName: impersonated_user_name ?? null,
      next: {
        impersonated_user_id,
        impersonated_user_name: impersonated_user_name ?? null,
        impersonated_role: impersonated_role ?? null,
        duration_seconds: duration_seconds ?? null,
      },
    });

    res.status(204).send();
  } catch (err) { next(err); }
});
