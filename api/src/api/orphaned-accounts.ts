import { Router } from 'express';
import { createClerkClient } from '@clerk/backend';
import { requireSuperadmin } from '../infra/tenantContext';
import { recordPlatformAudit } from '../infra/audit';
import {
  classifyAccount, loadAccountLinks, loadAccountLinksFor, unlinkClerkAccount,
} from '../infra/clerk-account-links';

/**
 * #709 part 3: Clerk login accounts linked to nothing in Gymdesk (see
 * infra/clerk-account-links.ts for the definition), listed for a superadmin
 * who decides which to delete — without going to the Clerk Dashboard.
 * Mounted at /platform/orphaned-accounts; requireSuperadmin gates every route.
 */
export const orphanedAccountsRouter = Router();

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

const PAGE = 500; // Clerk's getUserList maximum

async function listAllClerkUsers(): Promise<any[]> {
  const all: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await clerkClient.users.getUserList({ limit: PAGE, offset, orderBy: '-created_at' });
    all.push(...data);
    if (data.length < PAGE) return all;
  }
}

function primaryEmail(u: any): string | null {
  const e = u.emailAddresses?.find((x: any) => x.id === u.primaryEmailAddressId) ?? u.emailAddresses?.[0];
  return e?.emailAddress ?? null;
}

const toIso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

orphanedAccountsRouter.get('/', requireSuperadmin, async (_req, res, next) => {
  try {
    const users = await listAllClerkUsers();
    const links = await loadAccountLinks(users.map((u) => u.id));
    const now = Date.now();
    const rows = users.flatMap((u) => {
      const l = links.get(u.id)!;
      const status = classifyAccount(u, l, now);
      if (status.linked) return [];
      return [{
        id: u.id,
        email: primaryEmail(u),
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
        created_at: toIso(u.createdAt),
        last_sign_in_at: toIso(u.lastSignInAt),
        reason: status.reason,
        deletable: status.deletable,
        // The gyms the account used to belong to, for the superadmin's context.
        gyms: l.deletedMemberGyms,
      }];
    });
    res.json(rows);
  } catch (err) { next(err); }
});

orphanedAccountsRouter.delete('/:userId', requireSuperadmin, async (req, res, next) => {
  const userId = String(req.params.userId);
  try {
    let user: any;
    try {
      user = await clerkClient.users.getUser(userId);
    } catch (err: any) {
      if (err.status === 404) return res.status(404).json({ error: 'Account not found' });
      throw err;
    }

    // Re-check now: the account may have been linked since the list loaded.
    const status = classifyAccount(user, await loadAccountLinksFor(userId));
    if (status.linked) return res.status(409).json({ error: 'This account is linked to Gymdesk and cannot be deleted here.' });
    if (!status.deletable) return res.status(409).json({ error: 'This sign-up is still in progress.' });

    // Clerk first: if it fails nothing in Gymdesk changes, so no half-deleted state.
    try {
      await clerkClient.users.deleteUser(userId);
    } catch (err: any) {
      req.log.error({ userId, status: err.status, message: err.message }, 'Orphaned account: Clerk delete failed');
      return res.status(502).json({ error: 'Failed to delete the account in Clerk. Nothing was changed.' });
    }
    const cleaned = await unlinkClerkAccount(userId);

    recordPlatformAudit(req, {
      action: 'delete',
      entityType: 'clerk_account',
      entityId: userId,
      entityName: primaryEmail(user),
      previous: { email: primaryEmail(user), reason: status.reason },
      next: { removed_gym_memberships: cleaned.memberships, unlinked_members: cleaned.members },
    });
    res.status(204).send();
  } catch (err) { next(err); }
});
