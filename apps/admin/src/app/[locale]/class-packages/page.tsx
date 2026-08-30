import { permanentRedirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

export default async function ClassPackagesRedirectPage() {
  const locale = await getLocale();
  permanentRedirect(`/${locale}/financials/sellable-items`);
}
