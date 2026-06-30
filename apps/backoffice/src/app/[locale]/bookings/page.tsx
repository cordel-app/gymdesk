import { getTranslations } from 'next-intl/server';

export default async function BookingsPage() {
  const t = await getTranslations();
  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('nav.bookings')}</h1>
      <p style={{ color: '#666' }}>{t('common.coming_soon')}</p>
    </div>
  );
}
