/**
 * #1072 (mobile app WP1) — the **pure** half of push delivery: which
 * credentials this deployment holds, what one FCM message looks like, and what
 * a failed send means for the token it was sent to.
 *
 * `api/src/infra/push.ts` beside it owns the I/O (minting an access token,
 * the HTTP call, deleting a dead row). The split is the one `domain/` ↔ `infra/`
 * split the rest of the codebase uses, and it is what makes the three decisions
 * below assertable without a network: the parser, the message shape and the
 * delete rule are each a unit test rather than a mocked round trip.
 */

/** One Firebase project's service account, as this deployment holds it. */
export interface FcmServiceAccount {
  /** The app (Bundle ID / package) whose tokens this account may send to. */
  appId: string;
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface ParsedServiceAccounts {
  accounts: Map<string, FcmServiceAccount>;
  /** Why an entry was dropped. Logged once at boot; never thrown — see below. */
  errors: string[];
}

/**
 * A PEM private key as a JSON string literal carries its newlines escaped
 * (`\\n`), which is how Google's own service-account file and every secret
 * manager hand it over. `JSON.parse` already unescapes those, so this only
 * repairs the other common shape: a key pasted into an env var with the two
 * characters `\` + `n` where a newline belongs. Without it `crypto.createSign`
 * rejects the key with an opaque OpenSSL error, which is the kind of failure
 * that gets diagnosed as "push does not work".
 */
export function normalizePrivateKey(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

/**
 * Reads `FCM_SERVICE_ACCOUNTS`: a JSON object keyed by **app id**, each value a
 * Google service-account JSON (`project_id`, `client_email`, `private_key`; the
 * other fields of that file are ignored).
 *
 * ```
 * FCM_SERVICE_ACCOUNTS={"com.cordel.fitness":{"project_id":"…","client_email":"…","private_key":"-----BEGIN…"}}
 * ```
 *
 * One variable rather than a trio per app, because `docs/mobile-app.md` rule 1
 * is that no app identity is hard-coded and rule 6 is that per-gym apps
 * multiply the store plumbing and not the code: a stage-2 app is a new key in
 * this object, with no code change and no new variable name to invent.
 *
 * **A malformed entry is dropped and reported, never thrown.** Push is
 * fire-and-forget by design (the `member_notifications` row is the durable
 * half), so a typo in one app's credentials must not take the API down at boot
 * or fail a booking — it costs that app its push, which is exactly what having
 * no credentials at all costs.
 */
export function parseServiceAccounts(raw: string | undefined | null): ParsedServiceAccounts {
  const accounts = new Map<string, FcmServiceAccount>();
  const errors: string[] = [];
  if (!raw || !raw.trim()) return { accounts, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    errors.push(`FCM_SERVICE_ACCOUNTS is not valid JSON: ${err?.message ?? 'parse error'}`);
    return { accounts, errors };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push('FCM_SERVICE_ACCOUNTS must be a JSON object keyed by app id');
    return { accounts, errors };
  }

  for (const [appId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = appId.trim();
    if (!key) {
      errors.push('FCM_SERVICE_ACCOUNTS has an entry with an empty app id');
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`FCM_SERVICE_ACCOUNTS["${key}"] must be a service-account object`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const projectId = typeof entry.project_id === 'string' ? entry.project_id.trim() : '';
    const clientEmail = typeof entry.client_email === 'string' ? entry.client_email.trim() : '';
    const privateKey = typeof entry.private_key === 'string' ? entry.private_key : '';
    const missing = [
      projectId ? null : 'project_id',
      clientEmail ? null : 'client_email',
      privateKey ? null : 'private_key',
    ].filter(Boolean);
    if (missing.length > 0) {
      errors.push(`FCM_SERVICE_ACCOUNTS["${key}"] is missing ${missing.join(', ')}`);
      continue;
    }
    accounts.set(key, {
      appId: key,
      projectId,
      clientEmail,
      privateKey: normalizePrivateKey(privateKey),
    });
  }

  return { accounts, errors };
}

/** FCM HTTP v1's send endpoint for one project. */
export function fcmSendUrl(projectId: string): string {
  return `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}

/** What `buildPushMessage()` is given: one `member_notifications` row's content. */
export interface PushNotificationContent {
  type: string;
  entityType: string | null;
  entityId: number | null;
  payload: Record<string, unknown>;
}

/**
 * One FCM HTTP v1 message for one token.
 *
 * Two deliberate restraints.
 *
 * **The title is the payload's own, and there is no body.** `payload.title` is
 * already human text (the class or event name the alert is about), while the
 * *sentence* a member reads — "You are on the waiting list", "Your class was
 * cancelled" — is a locale key the Members App resolves per notification type
 * (`apps/member/locales/base/{en,es,ca}.json`). Composing it here would be a
 * second copy of that copy, in a module that would then have to pick a language;
 * a member's stored `preferred_locale` (#1039) makes that answerable, but
 * answering it is the ticket that decides where push copy lives, not this one.
 *
 * **The `data` block is for routing, not for display.** It carries the type and
 * the entity so a tapped notification can open `/notifications` (WP2) and
 * nothing that would need translating. Every FCM `data` value must be a string,
 * so the payload travels as JSON text and the ids as decimal strings.
 */
export function buildPushMessage(token: string, content: PushNotificationContent): object {
  const title = typeof content.payload.title === 'string' ? content.payload.title.trim() : '';
  const data: Record<string, string> = {
    type: content.type,
    entity_type: content.entityType ?? '',
    entity_id: content.entityId === null ? '' : String(content.entityId),
    payload: JSON.stringify(content.payload ?? {}),
  };
  const message: Record<string, unknown> = { token, data };
  if (title) message.notification = { title };
  return { message };
}

/**
 * What a failed send means for the row it was sent to.
 *
 * `'delete'` only where FCM has told us the token can never work again:
 * `UNREGISTERED` (the app was uninstalled or the token was refreshed, answered
 * as 404) and `SENDER_ID_MISMATCH` (the token belongs to another Firebase
 * project, answered as 403 — it will never be deliverable by *this* account, so
 * keeping it would retry it every night for ever).
 *
 * Everything else is `'keep'`, and `INVALID_ARGUMENT` is the reason this
 * function exists rather than a status check at the call site: FCM answers it
 * both for a malformed token *and* for a malformed message, so a bug in
 * `buildPushMessage()` would delete every token of every member on its first
 * run. A quota error (429) and a provider outage (5xx) are the same judgment as
 * the nightly run's `provider_error` (CLAUDE.md #785): an unknown outcome is not
 * evidence against the token.
 */
export function pushFailureAction(status: number, errorCode: string | null): 'delete' | 'keep' {
  if (errorCode === 'UNREGISTERED' || errorCode === 'SENDER_ID_MISMATCH') return 'delete';
  if (status === 404 && !errorCode) return 'delete';
  return 'keep';
}

/**
 * FCM's own error code inside an HTTP v1 error body, which carries it in
 * `error.details[]` (`{"@type": ".../FcmError", "errorCode": "UNREGISTERED"}`)
 * rather than in `error.status`. Returns null for a body that names none, which
 * `pushFailureAction()` reads as "keep unless the status alone is conclusive".
 */
export function fcmErrorCode(body: unknown): string | null {
  const error = (body as any)?.error;
  if (!error || typeof error !== 'object') return null;
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    const code = (detail as any)?.errorCode;
    if (typeof code === 'string' && code) return code;
  }
  return typeof error.status === 'string' && error.status ? error.status : null;
}
