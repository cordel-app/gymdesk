import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createClerkClient } from '@clerk/backend';
import { db } from '../infra/db';
import { parseBody, z } from '../infra/validate';
import { isStaffLoginEmail } from '../infra/staff-access';
import { verifyWebsiteApiKey } from '../infra/website-api-key';

/**
 * #599: website self-registration. Mounted at /public/gyms/:gymRef/registrations.
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
 *
 * #645: `:gymRef` is `{gymId}-{gym-name}`, so the gym is identified by its id
 * and two gyms with the same name can never share an endpoint (a bare slug,
 * the pre-#645 format, still resolves — see parseGymRef). The same route also
 * answers a connectivity probe that registers nobody — see isHealthCheckBody.
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

// gyms.id is a CHAR(36) UUID; the readable half that follows it is whatever the
// gym's slug happens to be, hyphens included, so the id is taken by length.
const GYM_ID_LENGTH = 36;
const GYM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GymRef = { by: 'id' | 'slug'; value: string };

/**
 * #645: resolves `{gymId}-{gym-name}` to the gym id. The name half is there for
 * readability only and is never matched against anything, so a renamed gym
 * keeps working and two gyms sharing a name still get distinct endpoints.
 *
 * A reference that doesn't start with a gym id falls back to the pre-#645
 * `{gym-slug}` format, so WordPress installs configured before this change keep
 * registering. Slugs are slugified gym names, so one shaped like a UUID
 * followed by a hyphen — the only way the two forms could overlap — is not
 * something the platform generates.
 */
export function parseGymRef(ref: string): GymRef {
  const id = ref.slice(0, GYM_ID_LENGTH);
  if (GYM_ID_RE.test(id) && (ref.length === GYM_ID_LENGTH || ref[GYM_ID_LENGTH] === '-')) {
    return { by: 'id', value: id.toLowerCase() };
  }
  return { by: 'slug', value: ref };
}

// Unknown gym, deleted/inactive gym and wrong key all get the same 401.
async function requireWebsiteApiKey(req: Request, res: Response, next: NextFunction) {
  try {
    const ref = parseGymRef(String((req.params as any).gymRef ?? ''));
    const { rows } = await db.query<{
      id: string; website_api_key_hash: string | null; website_api_key_prefix: string | null;
    }>(
      `SELECT id, website_api_key_hash, website_api_key_prefix FROM gyms
        WHERE ${ref.by === 'id' ? 'id' : 'slug'} = ? AND deleted_at IS NULL AND status = 'active'`,
      [ref.value],
    );
    const gym = rows[0];
    if (!(await verifyWebsiteApiKey(req.headers['x-api-key'], gym?.website_api_key_hash, gym?.website_api_key_prefix))) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    (req as any).registrationGymId = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * #645: the connectivity probe a website sends to prove the endpoint and the
 * key work, without registering anybody. It is exactly `{ name: 'test',
 * email: '' }` — a real registration always carries a non-empty email, which
 * the schema below requires, so the two can never be confused.
 */
export function isHealthCheckBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { name, email } = body as Record<string, unknown>;
  return typeof name === 'string' && name.trim().toLowerCase() === 'test'
    && typeof email === 'string' && email.trim() === '';
}

// A health check writes nothing, so it must not spend the gym's daily
// registration quota; the per-IP limiter ahead of it still applies.
const registrationGymLimiter = (req: Request, res: Response, next: NextFunction) =>
  isHealthCheckBody(req.body) ? next() : (gymLimiter as any)(req, res, next);

const registrationSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(255),
  email: z.string().trim().toLowerCase().max(255).pipe(z.email('email is invalid')),
  locale: z.enum(MEMBER_APP_LOCALES).optional(),
  // #757: no center_id — a registration joins the gym; the member's center is
  // decided later, not here. One sent by an older site is dropped (z.object
  // strips unknown keys), never rejected.
});

publicRegistrationsRouter.post('/', ipLimiter as any, requireWebsiteApiKey, registrationGymLimiter, async (req, res, next) => {
  const gymId: string = (req as any).registrationGymId;

  // #645: the key is valid and the gym resolved — that is all the probe asks.
  // Nothing is written, no invitation is created and no email goes out.
  if (isHealthCheckBody(req.body)) {
    req.log.info({ gymId }, 'Website registration health check');
    return res.status(200).json({ ok: true, health_check: true });
  }

  const body = parseBody(req, res, registrationSchema);
  if (!body) return;

  try {
    const accepted = () => res.status(202).json({ ok: true });
    // #701: Spanish is the default, matching the Clerk Invitation template's
    // fallback language, so the email and the page the link opens always agree.
    const locale = body.locale ?? 'es';
    const redirectUrl = `${process.env.CORDEL_FITNESS_MEMBERS_URL ?? ''}/${locale}/link?gym_id=${gymId}`;
    // The template picks Catalan / English from these flags and falls back to
    // Spanish, so Spanish needs none (Handlebars `#if` can't compare strings).
    const lang = locale === 'es' ? {} : { lang: { [locale]: true } };

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

    // Staff already added this person: the row exists, /me/link just links it.
    const publicMetadata = {
      ...lang,
      ...(member ? {} : { gym_signup: { gym_id: gymId, name: body.name } }),
    };

    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: body.email,
        redirectUrl,
        ...(Object.keys(publicMetadata).length ? { publicMetadata } : {}),
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
