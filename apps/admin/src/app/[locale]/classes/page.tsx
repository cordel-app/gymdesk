import { getTranslations } from 'next-intl/server';

export default async function ClassesPage() {
  const t = await getTranslations();
  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('nav.classes')}</h1>
      <p style={{ color: '#666' }}>{t('common.coming_soon')}</p>
    </div>
  );
}
