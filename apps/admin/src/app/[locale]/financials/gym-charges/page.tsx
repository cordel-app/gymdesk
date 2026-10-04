import { permanentRedirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

// This route's own name is what a Product was called two renames ago. It is
// kept as a redirect so a link or bookmark written then still lands, exactly as
// the route the rename before this one retired is. Its body names neither term,
// so the stage-3 gate reads it like any other file.
export default async function LegacyChargesRouteRedirectPage() {
  const locale = await getLocale();
  permanentRedirect(`/${locale}/financials/products`);
}
