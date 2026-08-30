import { permanentRedirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

export default async function GymChargesRedirectPage() {
  const locale = await getLocale();
  permanentRedirect(`/${locale}/financials/sellable-items`);
}
