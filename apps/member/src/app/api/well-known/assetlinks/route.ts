/**
 * #1076 (mobile app WP4) — `GET /.well-known/assetlinks.json`.
 *
 * Reached through the rewrite in `next.config.js` (the `.json` is part of the
 * path Android asks for, and a route-handler directory is not the place to
 * spell it). What it says is `lib/appAssociations.ts`' and how it is said is
 * `lib/wellKnownResponse.ts`'; this file is the route and decides nothing.
 */

import { androidAssetLinks } from '@/lib/appAssociations';
import { configuredAppAssociations, wellKnownResponse } from '@/lib/wellKnownResponse';

export const dynamic = 'force-dynamic';

export function GET() {
  const { apps, errors } = configuredAppAssociations();
  return wellKnownResponse(androidAssetLinks(apps), errors);
}
