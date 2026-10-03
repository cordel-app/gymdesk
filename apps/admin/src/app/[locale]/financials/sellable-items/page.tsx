import { permanentRedirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

// This route's own name is the term #949 retired; stage 2 moved the page to
// `financials/products`. Kept as a redirect so links and bookmarks written
// before the rename still land, exactly as `financials/gym-charges` is kept for
// the name before that.
export default async function RetiredProductsRouteRedirectPage() {
  const locale = await getLocale();
  permanentRedirect(`/${locale}/financials/products`);
}
