import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { getTenantContext, requireSuperadmin } from '../infra/tenantContext';
import { recordAudit } from '../infra/audit';

/**
 * #51: manage the platform_role='superadmin' Clerk metadata from within the
 * admin app. Only /platform/superadmins/* — requireSuperadmin gates the
 * whole router. All three write endpoints emit audit_logs rows (entity_type
 * 'superadmin').
 *
 * Onboarding flow:
 *   - Grant by email of a user Clerk already knows → publicMetadata write.
 *   - Grant by email Clerk doesn't know → send an invitation carrying the
 *     platform_role in publicMetadata, so the invitee lands as a superadmin
 *     when they accept (Clerk applies invitation metadata on account creation).
 *
 * Self-revoke is blocked so the caller can't accidentally lock the platform
 * out of superadmin access via the UI. (A second superadmin can revoke the
 * first; the "at least one seed superadmin" contract is upheld by convention,
 * not enforcement — see api/src/infra/seed.ts.)
 */
export const superadminsRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

function shapeUser(u: any) {
  const primaryEmail = u.emailAddresses?.find((e: any) => e.id === u.primaryEmailAddressId)
    ?? u.emailAddresses?.[0];
  return {
    id: u.id,
    email: primaryEmail?.emailAddress ?? null,
    first_name: u.firstName ?? null,
    last_name: u.lastName ?? null,
    created_at: u.createdAt ? new Date(u.createdAt).toISOString() : null,
  };
}

superadminsRouter.get('/', requireSuperadmin, async (_req, res, next) => {
  try {
    // Clerk's SDK doesn't support metadata filters; small N (superadmins are
    // a handful platform-wide), so fetch a page and filter in memory. Bump
    // the limit if the platform ever crosses ~500 users.
    const { data: users } = await clerkClient.users.getUserList({ limit: 500 });
    const rows = users
      .filter((u: any) => (u.publicMetadata as any)?.platform_role === 'superadmin')
      .map(shapeUser);
    res.json(rows);
  } catch (err) { next(err); }
});

superadminsRouter.post('/', requireSuperadmin, async (req, res, next) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    // Look up existing user
    const { data: matches } = await clerkClient.users.getUserList({ emailAddress: [email], limit: 1 });
    const existing = matches[0];

    if (existing) {
      // Already superadmin? Idempotent no-op → return current shape.
      const meta = (existing.publicMetadata as any) ?? {};
      if (meta.platform_role === 'superadmin') {
        return res.status(200).json({ status: 'already_granted', user: shapeUser(existing) });
      }
      await clerkClient.users.updateUserMetadata(existing.id, {
        publicMetadata: { ...meta, platform_role: 'superadmin' },
      });
      const updated = await clerkClient.users.getUser(existing.id);
      recordAudit(req, { action: 'grant', entityType: 'superadmin', entityId: existing.id, next: { email } });
      return res.status(201).json({ status: 'granted', user: shapeUser(updated) });
    }

    // No Clerk user yet — send an invitation with the role baked in.
    const adminUrl = process.env.CORDEL_FITNESS_ADMIN_URL ?? '';
    try {
      await clerkClient.invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { platform_role: 'superadmin' },
        // If the admin URL isn't configured (local dev without .env), Clerk
        // still sends the invitation; the invitee lands on Clerk's default
        // sign-up and the metadata is applied regardless.
        ...(adminUrl ? { redirectUrl: `${adminUrl}/en/sign-up` } : {}),
      });
      recordAudit(req, { action: 'invite', entityType: 'superadmin', entityId: email, next: { email } });
      return res.status(201).json({ status: 'invited', email });
    } catch (err: any) {
      // Clerk returns 422 for duplicate pending invitations
      if (err.status === 422) {
        return res.status(409).json({ error: 'An invitation is already pending for this email.' });
      }
      throw err;
    }
  } catch (err) { next(err); }
});

superadminsRouter.delete('/:userId', requireSuperadmin, async (req, res, next) => {
  const { userId: callerUserId } = getTenantContext(req);
  const targetId = String(req.params.userId);
  if (targetId === callerUserId) {
    return res.status(400).json({ error: 'Cannot revoke your own superadmin role. Ask another superadmin to do it.' });
  }
  try {
    const user = await clerkClient.users.getUser(targetId).catch(() => null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const meta = (user.publicMetadata as any) ?? {};
    if (meta.platform_role !== 'superadmin') {
      return res.status(404).json({ error: 'User is not a superadmin' });
    }
    // Unset by writing everything else back. Clerk's updateUserMetadata does
    // a shallow merge on publicMetadata, so setting the key to null clears it.
    await clerkClient.users.updateUserMetadata(targetId, {
      publicMetadata: { ...meta, platform_role: null },
    });
    recordAudit(req, { action: 'revoke', entityType: 'superadmin', entityId: targetId, previous: { platform_role: 'superadmin' } });
    res.status(204).send();
  } catch (err) { next(err); }
});
