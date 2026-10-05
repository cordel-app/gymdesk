/**
 * #1076 (mobile app WP4) — the **one** place that decides what the two
 * site-association files say, and which URLs of this app open the native shell.
 *
 * `docs/mobile-app.md` WP4: an invitation link tapped in Mail or Notes should
 * open the app rather than the browser, which both platforms grant by fetching
 * a file from the domain the link is on. iOS reads
 * `/.well-known/apple-app-site-association` and Android reads
 * `/.well-known/assetlinks.json`; the two route handlers under
 * `app/api/well-known/` serve exactly what this module builds, and
 * `next.config.js` rewrites the canonical paths onto them (a rewrite, never a
 * redirect — Apple refuses a redirected association file).
 *
 * It is **pure** — no `fs`, no `next/*`, no route knowledge — for the reason
 * `lib/native.ts` is (#1073 design rule 3): what the files say is then
 * assertable with no server, no device and no store account, which is the only
 * kind of test this repository can run for a native capability.
 *
 * Five of its answers are the rule rather than the implementation.
 *
 * **Which paths open the app is one declaration, in two syntaxes.** An
 * invitation is `/{locale}/link?gym_id=…&__clerk_ticket=…`
 * (`api/src/api/members.ts`, `public-registrations.ts`), so
 * `APP_LINK_PATH_SEGMENT` is the whole rule and the Apple component and the
 * Android `pathPattern` are *derived* from it. The native half cannot import
 * this module (`apps/mobile` is another workspace, and the Android manifest is
 * XML), so `api/src/test/mobile-app-links.unit.test.ts` fails the build when
 * the committed manifest stops matching what this file publishes — a mismatch
 * is otherwise invisible until an Android link opens the browser while the same
 * link opens the app on iOS.
 *
 * **The app claims the invitation path and nothing else.** A `"/": "/*"` would
 * hand the shell every URL on the domain, including the OAuth and Clerk
 * redirects a sign-in bounces through, and a link the app swallows at the wrong
 * moment has no way back to the browser.
 *
 * **What a build is for is configuration, never a literal** (design rule 1).
 * The Apple Team ID and the Android signing fingerprints are the deployment's
 * to supply, in one variable keyed by **app id** — the shape
 * `FCM_SERVICE_ACCOUNTS` already uses (#1072), and for its reason: a stage-2
 * per-gym app is a new key in that object with no code change and no new
 * variable name to invent. The *mobile* side of a build reads
 * `apps/mobile/profiles/<id>.json`, which this app cannot see — its Docker
 * build copies `apps/member` and `shared` only — so the values the web half
 * needs are env, and they are the ones a profile file could not hold anyway: a
 * Team ID and a release certificate belong to the store account, not to the
 * shell's source.
 *
 * **A malformed entry is dropped and reported, never published.** An
 * association file is read by Apple's and Google's CDNs and cached for a day:
 * publishing a wrong `appID` or a 31-byte fingerprint claims an association
 * that silently cannot work, which is worse than claiming none. So an entry
 * that fails its shape is left out and named in the returned `errors`, which
 * the route logs.
 *
 * **A file with nothing to say is absent.** With no configured app, both
 * builders answer `null` and the routes answer `404` — WP2's "a native control
 * that cannot work is absent, never broken" one layer down. A `404` is what an
 * operator sees immediately; a `200` carrying an empty `details` array looks
 * configured and is not.
 */

/**
 * The path segment an invitation link ends on, under its own locale segment.
 *
 * Kept as the segment rather than as a pattern because each platform spells the
 * wildcard differently and both are derived from it below.
 */
export const APP_LINK_PATH_SEGMENT = 'link';

/**
 * The Apple `components` entry for an invitation link.
 *
 * `*` matches the locale segment the link was written in (`/en/link`,
 * `/es/link`, …). No `"?"` component is declared, so any query matches — the
 * query is what carries `gym_id` and `__clerk_ticket`, and it varies per
 * invitation.
 */
export const APPLE_APP_LINK_COMPONENT = `/*/${APP_LINK_PATH_SEGMENT}`;

/** The same rule in Android's `pathPattern` syntax (`.*` where Apple has `*`). */
export const ANDROID_APP_LINK_PATH_PATTERN = `/.*/${APP_LINK_PATH_SEGMENT}`;

/** The relation an App Links statement grants — Android's one spelling of it. */
export const ANDROID_APP_LINK_RELATION = 'delegate_permission/common.handle_all_urls';

/** The one variable the association files are built from. */
export const APP_ASSOCIATIONS_ENV_KEY = 'MOBILE_APP_ASSOCIATIONS';

/** One app a build of this deployment is published as. */
export interface AppAssociation {
  /** The Bundle ID (iOS) / `applicationId` (Android) — the profile's `appId`. */
  appId: string;
  /** The Apple Developer Team ID that signs it, or `null` when not configured. */
  appleTeamId: string | null;
  /** SHA-256 fingerprints of the Android signing certificates, normalized. */
  androidCertFingerprints: string[];
}

export interface ParsedAppAssociations {
  apps: AppAssociation[];
  errors: string[];
}

/** An Apple `applinks` document, as the AASA file holds it. */
export interface AppleAppSiteAssociation {
  applinks: {
    /**
     * Empty, always. iOS 13 and later read `details[].appIDs` and ignore this
     * key; the versions before it required the key to be present. It costs one
     * line and removes a failure nothing here could reproduce.
     */
    apps: string[];
    details: { appIDs: string[]; components: { '/': string; comment: string }[] }[];
  };
}

/** One Android App Links statement. */
export interface AndroidAssetLinkStatement {
  relation: string[];
  target: {
    namespace: 'android_app';
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}

/**
 * Reads `MOBILE_APP_ASSOCIATIONS`: a JSON object keyed by **app id**, each
 * value naming the credentials that app is published under.
 *
 * ```
 * MOBILE_APP_ASSOCIATIONS={"com.cordel.fitness":{"apple_team_id":"ABCDE12345","android_sha256_cert_fingerprints":["AA:BB:…"]}}
 * ```
 *
 * Either half may be omitted: an app with a Team ID and no fingerprint is
 * published in the AASA and not in `assetlinks.json`, which is exactly what an
 * iOS-only release is. An entry naming neither is dropped and reported, because
 * it associates nothing and is more likely a typo than an intention.
 */
export function parseAppAssociations(raw: string | undefined | null): ParsedAppAssociations {
  const apps: AppAssociation[] = [];
  const errors: string[] = [];
  if (!raw || !raw.trim()) return { apps, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeConfiguredJson(raw));
  } catch (err: any) {
    errors.push(`${APP_ASSOCIATIONS_ENV_KEY} is not valid JSON: ${err?.message ?? 'parse error'}`);
    return { apps, errors };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`${APP_ASSOCIATIONS_ENV_KEY} must be a JSON object keyed by app id`);
    return { apps, errors };
  }

  for (const [appId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = appId.trim();
    if (!key) {
      errors.push(`${APP_ASSOCIATIONS_ENV_KEY} has an entry with an empty app id`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${APP_ASSOCIATIONS_ENV_KEY}["${key}"] must be an object`);
      continue;
    }
    const entry = value as Record<string, unknown>;
    const errorsBefore = errors.length;

    const teamIdRaw = typeof entry.apple_team_id === 'string' ? entry.apple_team_id.trim() : '';
    let appleTeamId: string | null = null;
    if (teamIdRaw) {
      // A Team ID is the first half of `appID` ("TEAMID.com.example.app"), so a
      // value carrying a dot, a space or a colon would not merely be wrong — it
      // would make the whole identifier unreadable.
      if (/^[A-Za-z0-9]+$/.test(teamIdRaw)) appleTeamId = teamIdRaw.toUpperCase();
      else
        errors.push(
          `${APP_ASSOCIATIONS_ENV_KEY}["${key}"].apple_team_id must be alphanumeric (an Apple Team ID, e.g. ABCDE12345)`,
        );
    }

    const androidCertFingerprints: string[] = [];
    const fingerprints = entry.android_sha256_cert_fingerprints;
    if (fingerprints !== undefined && fingerprints !== null) {
      if (!Array.isArray(fingerprints)) {
        errors.push(
          `${APP_ASSOCIATIONS_ENV_KEY}["${key}"].android_sha256_cert_fingerprints must be an array of SHA-256 fingerprints`,
        );
      } else {
        for (const candidate of fingerprints) {
          const normalized = normalizeCertFingerprint(candidate);
          if (!normalized) {
            errors.push(
              `${APP_ASSOCIATIONS_ENV_KEY}["${key}"] has a value that is not a SHA-256 fingerprint (32 hex bytes)`,
            );
            continue;
          }
          if (!androidCertFingerprints.includes(normalized)) androidCertFingerprints.push(normalized);
        }
      }
    }

    if (!appleTeamId && androidCertFingerprints.length === 0) {
      // Only when the entry genuinely named nothing: an entry whose Team ID was
      // refused above has already been reported, and a second line about the
      // same key reads as two problems.
      if (errors.length === errorsBefore) {
        errors.push(
          `${APP_ASSOCIATIONS_ENV_KEY}["${key}"] names neither apple_team_id nor android_sha256_cert_fingerprints`,
        );
      }
      continue;
    }

    apps.push({ appId: key, appleTeamId, androidCertFingerprints });
  }

  return { apps, errors };
}

/**
 * A SHA-256 certificate fingerprint in the form Google's verifier compares,
 * or `null` when the value is not one.
 *
 * `keytool` prints it colon-separated and uppercase, Play Console copies it the
 * same way, and `gradle signingReport` sometimes hands over bare hex — so the
 * separators are stripped and re-inserted rather than trusted. The length is
 * the check that matters: a SHA-1 fingerprint (20 bytes) pasted where a SHA-256
 * belongs is the common mistake, and it would publish a statement no install
 * ever verifies.
 */
export function normalizeCertFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return (hex.match(/.{2}/g) as string[]).join(':');
}

/** `TEAMID.com.example.app` — the identifier Apple matches an install against. */
export function appleAppId(app: AppAssociation): string | null {
  return app.appleTeamId ? `${app.appleTeamId}.${app.appId}` : null;
}

/**
 * The Apple association document, or `null` when no configured app has a Team
 * ID — see the module comment on why that is a `404` rather than an empty file.
 */
export function appleAppSiteAssociation(
  apps: readonly AppAssociation[],
): AppleAppSiteAssociation | null {
  const details = apps
    .map((app) => appleAppId(app))
    .filter((id): id is string => id !== null)
    .map((id) => ({
      appIDs: [id],
      components: [
        {
          '/': APPLE_APP_LINK_COMPONENT,
          comment: 'invitation link',
        },
      ],
    }));
  if (details.length === 0) return null;
  return { applinks: { apps: [], details } };
}

/**
 * The Android App Links statements, or `null` when no configured app has a
 * fingerprint.
 *
 * `handle_all_urls` is the only relation Android defines for this, and the
 * paths an app actually claims are the manifest's `intent-filter` — this file
 * grants the app the domain and says nothing about paths, which is why
 * `ANDROID_APP_LINK_PATH_PATTERN` has to be asserted against the manifest
 * instead.
 */
export function androidAssetLinks(
  apps: readonly AppAssociation[],
): AndroidAssetLinkStatement[] | null {
  const statements = apps
    .filter((app) => app.androidCertFingerprints.length > 0)
    .map((app) => ({
      relation: [ANDROID_APP_LINK_RELATION],
      target: {
        namespace: 'android_app' as const,
        package_name: app.appId,
        sha256_cert_fingerprints: [...app.androidCertFingerprints],
      },
    }));
  if (statements.length === 0) return null;
  return statements;
}

/**
 * The variable's value, which may be the JSON itself **or** that JSON
 * base64-encoded — one variable with one meaning, not two mechanisms.
 *
 * Exactly `parseServiceAccounts()`'s reasoning (`api/src/domain/pushDelivery.ts`):
 * the deployment carries its environment as inline `Environment=KEY=value` lines
 * in a systemd quadlet unit, where a JSON object has to survive the shell, the
 * SSH action and systemd's own quoting. A value starting with `{` is read as
 * JSON directly, so a local `.env` stays readable.
 */
function decodeConfiguredJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    return decoded.trim().startsWith('{') ? decoded : trimmed;
  } catch {
    return trimmed;
  }
}
