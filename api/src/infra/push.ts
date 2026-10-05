/**
 * #1072 (mobile app WP1) — push delivery to a member's devices, through
 * **FCM HTTP v1**.
 *
 * This is the I/O half; every rule it applies is `domain/pushDelivery.ts`'s
 * (which credentials exist, what a message looks like, when a token is dead).
 *
 * ── Why no SDK ──────────────────────────────────────────────────────────────
 *
 * `firebase-admin` would pull a large dependency tree into the API image for
 * one signed HTTP call. The whole protocol is a service-account JWT exchanged
 * for an access token and a POST per token, which is `node:crypto` plus
 * `fetch` — both already in the runtime. The legacy `fcm.googleapis.com/fcm/send`
 * server-key API is decommissioned, so HTTP v1 is the only option either way.
 *
 * ── Fire-and-forget, like the row it follows ────────────────────────────────
 *
 * `sendNotification()` has always been fire-and-forget: the durable fact is the
 * `member_notifications` row the Members App reads, and a push is a courtesy
 * copy of it. So nothing here is awaited by a request path, every failure is
 * logged and swallowed, and a deployment with no `FCM_SERVICE_ACCOUNTS` does
 * not even reach the database — which is also what keeps the whole of this
 * module inert in tests and in local development.
 */

import crypto from 'node:crypto';
import { db } from './db';
import {
  buildPushMessage,
  fcmErrorCode,
  fcmSendUrl,
  parseServiceAccounts,
  pushFailureAction,
  type FcmServiceAccount,
  type PushNotificationContent,
} from '../domain/pushDelivery';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** An access token lives an hour; mint a new one a minute early. */
const TOKEN_SKEW_SECONDS = 60;

let cachedAccounts: Map<string, FcmServiceAccount> | null = null;
let cachedRaw: string | undefined;

/**
 * The parsed credentials, re-parsed when `FCM_SERVICE_ACCOUNTS` itself changes
 * (which in practice means a test setting it) rather than on every call. Parse
 * errors are reported once per distinct value, so a typo is visible in the log
 * without a line per notification.
 */
function serviceAccounts(): Map<string, FcmServiceAccount> {
  const raw = process.env.FCM_SERVICE_ACCOUNTS;
  if (cachedAccounts && raw === cachedRaw) return cachedAccounts;
  const { accounts, errors } = parseServiceAccounts(raw);
  for (const message of errors) console.error('[push] %s', message);
  cachedAccounts = accounts;
  cachedRaw = raw;
  return accounts;
}

/** Whether this deployment can send a push at all. */
export function isPushConfigured(): boolean {
  return serviceAccounts().size > 0;
}

/** Test seam: drop the parsed credentials and every minted access token. */
export function resetPushCredentialCache(): void {
  cachedAccounts = null;
  cachedRaw = undefined;
  accessTokens.clear();
}

const accessTokens = new Map<string, { token: string; expiresAt: number }>();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A service-account access token for FCM, cached until just before it expires.
 *
 * The JWT is signed locally (RS256 over the service account's private key) and
 * exchanged at Google's token endpoint — the `jwt-bearer` grant, which is what
 * every Google client library does under the hood.
 */
async function accessTokenFor(account: FcmServiceAccount): Promise<string> {
  const cacheKey = `${account.clientEmail}|${account.projectId}`;
  const cached = accessTokens.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - TOKEN_SKEW_SECONDS > now) return cached.token;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signature = base64url(
    crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey),
  );
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${body?.error_description ?? body?.error ?? 'no access_token'}`);
  }
  const expiresIn = Number(body.expires_in) || 3600;
  accessTokens.set(cacheKey, { token: body.access_token, expiresAt: now + expiresIn });
  return body.access_token;
}

interface TokenRow {
  id: number;
  member_id: number;
  token: string;
  app_id: string;
}

/** One notification to deliver, as the `member_notifications` writers hold it. */
export interface PushTarget extends PushNotificationContent {
  memberId: number;
}

/**
 * Sends one notification to every device of every named member, and deletes the
 * rows FCM reports as permanently dead.
 *
 * Grouped by `app_id` because credentials are per app (`docs/mobile-app.md`
 * rule 2): a token registered by an app this deployment holds no service
 * account for is skipped, not failed — that is the stage-2 case of a gym app
 * whose Firebase project has not been configured yet, and it must not look like
 * an error on every alert.
 */
async function deliver(gymId: string, targets: PushTarget[]): Promise<void> {
  const accounts = serviceAccounts();
  if (accounts.size === 0 || targets.length === 0) return;

  const byMember = new Map<number, PushTarget[]>();
  for (const target of targets) {
    const list = byMember.get(target.memberId);
    if (list) list.push(target);
    else byMember.set(target.memberId, [target]);
  }
  const memberIds = [...byMember.keys()];
  const marks = memberIds.map(() => '?').join(',');
  const { rows } = await db.query<TokenRow>(
    `SELECT id, member_id, token, app_id
       FROM member_device_tokens
      WHERE gym_id = ? AND member_id IN (${marks})`,
    [gymId, ...memberIds],
  );
  if (rows.length === 0) return;

  const deadTokenIds: number[] = [];
  for (const row of rows) {
    const account = accounts.get(row.app_id);
    if (!account) continue;
    for (const target of byMember.get(row.member_id) ?? []) {
      const outcome = await sendOne(account, row, target);
      if (outcome === 'delete') {
        deadTokenIds.push(row.id);
        break; // the token is gone; the rest of this member's alerts cannot reach it
      }
    }
  }

  if (deadTokenIds.length > 0) {
    const deadMarks = deadTokenIds.map(() => '?').join(',');
    await db.query(
      `DELETE FROM member_device_tokens WHERE gym_id = ? AND id IN (${deadMarks})`,
      [gymId, ...deadTokenIds],
    );
  }
}

async function sendOne(
  account: FcmServiceAccount,
  row: TokenRow,
  target: PushTarget,
): Promise<'sent' | 'delete' | 'failed'> {
  try {
    const token = await accessTokenFor(account);
    const res = await fetch(fcmSendUrl(account.projectId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildPushMessage(row.token, target)),
    });
    if (res.ok) return 'sent';
    const body = await res.json().catch(() => null);
    const code = fcmErrorCode(body);
    const action = pushFailureAction(res.status, code);
    // The token itself is never logged: it identifies one member's device and
    // the row id is enough to find it.
    console.warn(
      '[push] send failed (%s%s) for token %d, app %s — %s',
      res.status, code ? ` ${code}` : '', row.id, account.appId,
      action === 'delete' ? 'deleting the token' : 'keeping the token',
    );
    return action === 'delete' ? 'delete' : 'failed';
  } catch (err: any) {
    console.error('[push] send error for token %d: %s', row.id, err?.message ?? err);
    return 'failed';
  }
}

/**
 * Fire-and-forget entry point: the `member_notifications` writers call this
 * after the row is written, and never await it.
 *
 * Returns nothing and throws nothing. A push that fails is a push the member
 * does not get; the alert is still in the app, which is why none of this is
 * allowed to reach the caller (a booking must not 500 because Firebase is
 * having an afternoon).
 */
export function deliverPushNotifications(gymId: string, targets: PushTarget[]): void {
  if (targets.length === 0 || !isPushConfigured()) return;
  deliver(gymId, targets).catch((err: any) => {
    console.error('[push] delivery failed:', err?.message ?? err);
  });
}
