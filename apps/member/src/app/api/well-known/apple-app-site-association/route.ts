/**
 * #1076 (mobile app WP4) — `GET /.well-known/apple-app-site-association`.
 *
 * Reached through the rewrite in `next.config.js`, which keeps the response on
 * the path iOS asks for without a redirect. What it says is
 * `lib/appAssociations.ts`' and how it is said is `lib/wellKnownResponse.ts`';
 * this file is the route and decides nothing.
 */

import { appleAppSiteAssociation } from '@/lib/appAssociations';
import { configuredAppAssociations, wellKnownResponse } from '@/lib/wellKnownResponse';

// The document is built from the environment, so it is resolved per request:
// statically prerendering it would bake the build container's (empty)
// configuration into the deployed app.
export const dynamic = 'force-dynamic';

export function GET() {
  const { apps, errors } = configuredAppAssociations();
  return wellKnownResponse(appleAppSiteAssociation(apps), errors);
}
