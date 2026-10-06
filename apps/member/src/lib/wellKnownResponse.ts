/**
 * #1076 (mobile app WP4) — what the two `/.well-known/` routes answer, in one
 * place.
 *
 * The documents themselves are `lib/appAssociations.ts`' (pure); this is the
 * HTTP half, and it exists so the iOS and the Android route cannot answer the
 * same question two ways — they differ only in which builder they call.
 *
 * Three of its answers are the rule rather than the implementation.
 *
 * **`application/json`, always, and never a redirect.** Apple refuses an
 * association file served with any other `Content-Type` and refuses one reached
 * through a redirect (the path has no extension, so nothing infers the type for
 * us); Android's verifier is as strict about the type. The canonical paths are
 * mapped onto these routes by a `next.config.js` **rewrite**, which is internal
 * and keeps the `200` on the URL Apple asked for.
 *
 * **Nothing configured is a `404`.** A `200` carrying an empty `details` array
 * reads as "this domain is configured and associates no app", which is
 * indistinguishable from a working file in a log and in a browser — WP2's "a
 * native control that cannot work is absent, never broken", one layer down.
 *
 * **A malformed entry is logged here and nowhere else.** `parseAppAssociations()`
 * drops it and names it (it is pure and logs nothing); the response is the
 * association the rest of the configuration still supports, because one app's
 * typo must not take another app's universal links down.
 */

import { NextResponse } from 'next/server';
import { APP_ASSOCIATIONS_ENV_KEY, parseAppAssociations } from './appAssociations';

/** The one `Content-Type` either file may be served with. */
export const WELL_KNOWN_CONTENT_TYPE = 'application/json';

/**
 * Apple's CDN and Android's verifier both re-fetch on their own schedule and
 * cache for up to a day regardless of what we say, so this is about the
 * ordinary web caches in between — short enough that a corrected Team ID is not
 * stuck behind a CDN for a week.
 */
export const WELL_KNOWN_CACHE_CONTROL = 'public, max-age=3600';

export function wellKnownResponse(document: unknown | null, errors: readonly string[]): NextResponse {
  for (const error of errors) console.warn('%s: %s', APP_ASSOCIATIONS_ENV_KEY, error.replace(/[\r\n]/g, ''));
  if (document === null) {
    return new NextResponse(null, { status: 404 });
  }
  return new NextResponse(JSON.stringify(document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': WELL_KNOWN_CONTENT_TYPE,
      'Cache-Control': WELL_KNOWN_CACHE_CONTROL,
    },
  });
}

/** The configured apps, read from the environment at request time. */
export function configuredAppAssociations() {
  return parseAppAssociations(process.env[APP_ASSOCIATIONS_ENV_KEY]);
}
