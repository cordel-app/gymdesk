import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { parseBody, z } from '../infra/validate';
import { isStaffLoginEmail } from '../infra/staff-access';
import { verifyWebsiteApiKey } from '../infra/website-api-key';

/**
 * #599: website self-registration. Mounted at /public/gyms/:slug/registrations.
 *
 * Called server-to-server by the gym's website (WordPress), authenticated by
 * the per-gym API key in `x-api-key`. It only ever issues a Clerk invitation:
 * the `members` row is created on first sign-in by POST /me/link, from the
 * `gym_signup` metadata Clerk copies from the invitation onto the new user. A
 * fake request therefore costs one unused invitation and never reaches the
 * gym's roster.
 *
 * Once the caller is authenticated and the body is valid, the response is the
 * same 202 whatever the email turns out to be (new, invited, member, staff
 * login) — the endpoint must not become an oracle for who belongs to a gym.
 */
export const publicRegistrationsRouter = Router({ mergeParams: true });

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

const MEMBER_APP_LOCALES = ['en', 'es', 'ca'] as const;

const envLimit = (name: string, fallback: number) => () => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Runs before any DB work, so junk traffic is dropped without a query.
const ipLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: envLimit('PUBLIC_REGISTRATION_IP_LIMIT_PER_HOUR', 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// Keyed by gym and placed after the key check, so only authenticated calls
// spend a gym's quota — an attacker without the key can't exhaust it.
const gymLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  limit: envLimit('PUBLIC_REGISTRATION_GYM_LIMIT_PER_DAY', 200),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `gym:${(req as any).registrationGymId}`,
  message: { error: 'Too many requests.' },
});

// Unknown slug, deleted/inactive gym and wrong key all get the same 401.
async function requireWebsiteApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const { rows } = await db.query<{ id: string; website_api_key_hash: string | null }>(
      "SELECT id, website_api_key_hash FROM gyms WHERE slug = ? AND deleted_at IS NULL AND status = 'active'",
      [(req.params as any).slug],
    );
    if (!verifyWebsiteApiKey(req.headers['x-api-key'], rows[0]?.website_api_key_hash)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as any).registrationGymId = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}

const registrationSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(255),
  email: z.string().trim().toLowerCase().max(255).pipe(z.email('email is invalid')),
  center_id: z.coerce.number().int().positive().optional(),
  locale: z.enum(MEMBER_APP_LOCALES).optional(),
});

// A multi-center gym must say where the member belongs; a single-center gym
// never has to. Resolved now so the invitation carries a concrete center.
async function resolveCenter(gymId: string, centerId: number | undefined): Promise<number | { error: string }> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM centers WHERE gym_id = ? AND deleted_at IS NULL',
    [gymId],
  );
  if (centerId !== undefined) {
    return rows.some((r) => r.id === centerId) ? centerId : { error: 'center_id is invalid for this gym' };
  }
  if (rows.length === 1) return rows[0].id;
  return { error: 'center_id is required — this gym has multiple centers' };
}

publicRegistrationsRouter.post('/', ipLimiter as any, requireWebsiteApiKey, gymLimiter as any, async (req, res, next) => {
  const gymId: string = (req as any).registrationGymId;
  const body = parseBody(req, res, registrationSchema);
  if (!body) return;

  try {
    const center = await resolveCenter(gymId, body.center_id);
    if (typeof center !== 'number') return res.status(400).json({ error: center.error });

    const accepted = () => res.status(202).json({ ok: true });
    const redirectUrl = `${process.env.CORDEL_FITNESS_MEMBERS_URL ?? ''}/${body.locale ?? 'en'}/link?gym_id=${gymId}`;

    // #594: one email is never both member and staff of the same gym.
    if (await isStaffLoginEmail(gymId, body.email)) {
      req.log.info({ gymId }, 'Website registration ignored: staff login email');
      return accepted();
    }

    // members.email is unique platform-wide, so look the address up across gyms.
    const { rows: existing } = await db.query<{
      id: number; gym_id: string; clerk_user_id: string | null; invitation_id: string | null; deleted_at: Date | null;
    }>(
      'SELECT id, gym_id, clerk_user_id, invitation_id, deleted_at FROM members WHERE email = ?',
      [body.email],
    );
    const member = existing[0];
    const invitable = member && member.gym_id === gymId && !member.deleted_at
      && !member.clerk_user_id && !member.invitation_id;
    if (member && !invitable) {
      req.log.info({ gymId, memberId: member.id }, 'Website registration ignored: email already on a member record');
      return accepted();
    }

    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: body.email,
        redirectUrl,
        // Staff already added this person: the row exists, /me/link just links it.
        ...(member ? {} : { publicMetadata: { gym_signup: { gym_id: gymId, name: body.name, center_id: center } } }),
      });
      if (member) {
        await db.query('UPDATE members SET invitation_id = ? WHERE id = ? AND gym_id = ?', [invitation.id, member.id, gymId]);
      }
      req.log.info({ gymId, invitationId: invitation.id }, 'Website registration: invitation sent');
    } catch (err: any) {
      // 422 = an invitation is already pending or the account already exists.
      // Swallowing it is also the per-email throttle: no second email goes out.
      if (err.status !== 422) {
        req.log.error({ gymId, status: err.status, message: err.message }, 'Website registration: Clerk invitation failed');
        return res.status(502).json({ error: 'Registration is temporarily unavailable.' });
      }
      req.log.info({ gymId }, 'Website registration ignored: invitation pending or account exists');
    }
    return accepted();
  } catch (err) {
    next(err);
  }
});
