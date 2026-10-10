import { Router } from 'express';
import { db } from '../infra/db';
import { getTenantContext, requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { recordAudit } from '../infra/audit';
import { loadMemberProfile, resolveMemberId } from './me';
import {
  type MemberImageRow,
  STORAGE_NOT_INITIALIZED,
  clearMemberImage,
  gymStorageFolderPrefix,
  isMemberImageRefusal,
  memberImageBodyParser,
  parseMemberImageRequest,
  storeMemberImage,
} from './member-image-storage';

/**
 * #1375 — the Member's own profile image: `POST` and `DELETE /me/profile/image`.
 *
 * The staff pair (`POST`/`DELETE /members/:id/image`, #1374) made self-service.
 * Everything about the image itself is shared with it through
 * `member-image-storage.ts` — the request judgement, the key, upload-then-write,
 * the clear, the sweep — so a photo a member uploads and one staff upload are
 * the same photo on the same key, and neither path can accept what the other
 * refuses. What is this router's own:
 *
 * - **The Member is never named by the request** (#1036's rule): every route
 *   resolves the caller through `resolveMemberId()` and constrains the row on
 *   `(gym_id, id)`, so a body or query naming another member changes nothing.
 * - **The guard is the Profile page's**: `requireRole('member')` and
 *   `member_web.profile` — the flag the page itself is behind — so a gym that
 *   hid the Profile did not leave a write into it.
 * - **The answer is `GET /me/profile`'s** (`loadMemberProfile()`), so the page
 *   and the top-bar avatar read one shape.
 *
 * A superadmin impersonating a member reaches these exactly as they reach
 * `PATCH /me/profile`: impersonating is a staff action, and the Members App is
 * what hides the control (ticket §2). Mounted at `/me/profile/image` before
 * `/me` in `app.ts`, with the same middleware chain.
 */
export const meProfileImageRouter = Router();

const guard = [requireRole('member'), requireFeatureEnabled('member_web.profile')] as const;

/** The caller's own row, or the 404 for a member the gym no longer has. */
async function loadOwnMember(req: any, res: any): Promise<{ gymId: string; member: MemberImageRow } | null> {
  const ctx = getTenantContext(req);
  const memberId = await resolveMemberId(ctx.gymId, ctx);
  const { rows } = await db.query<MemberImageRow>(
    'SELECT id, name, image_url FROM members WHERE id = ? AND gym_id = ? AND deleted_at IS NULL',
    [memberId, ctx.gymId],
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'Member not found' });
    return null;
  }
  return { gymId: ctx.gymId, member: { id: rows[0].id, name: rows[0].name, image_url: rows[0].image_url } };
}

meProfileImageRouter.post('/', ...guard, memberImageBodyParser, async (req, res, next) => {
  try {
    const parsed = parseMemberImageRequest(req);
    if (isMemberImageRefusal(parsed)) return res.status(parsed.status).json(parsed.body);

    const own = await loadOwnMember(req, res);
    if (!own) return;
    const { gymId, member } = own;
    const folderPrefix = await gymStorageFolderPrefix(gymId);
    if (!folderPrefix) return res.status(STORAGE_NOT_INITIALIZED.status).json(STORAGE_NOT_INITIALIZED.body);

    const { gymMembershipId } = getTenantContext(req);
    const stored = await storeMemberImage({ gymId, folderPrefix, member, body: parsed, modifiedBy: gymMembershipId ?? null });
    if (isMemberImageRefusal(stored)) return res.status(stored.status).json(stored.body);

    recordAudit(req, {
      action: 'update', entityType: 'member', entityId: member.id,
      previous: { image_url: member.image_url }, next: { image_url: stored },
    });
    res.json(await loadMemberProfile(gymId, member.id));
  } catch (err) { next(err); }
});

meProfileImageRouter.delete('/', ...guard, async (req, res, next) => {
  try {
    const own = await loadOwnMember(req, res);
    if (!own) return;
    const { gymId, member } = own;
    const folderPrefix = await gymStorageFolderPrefix(gymId);
    const { gymMembershipId } = getTenantContext(req);

    await clearMemberImage({ gymId, folderPrefix, member, modifiedBy: gymMembershipId ?? null });

    recordAudit(req, {
      action: 'update', entityType: 'member', entityId: member.id,
      previous: { image_url: member.image_url }, next: { image_url: null },
    });
    res.json(await loadMemberProfile(gymId, member.id));
  } catch (err) { next(err); }
});
