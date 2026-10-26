'use client';

import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useGym } from '@/context/GymContext';
import { ProfessionalServicesView } from '@/components/professionalServices/ProfessionalServicesView';

/**
 * #1817 — Cordel → Base Professional Services, a superadmin-only catalogue.
 * Since #2110 it renders through the same `ProfessionalServicesView` as a gym's
 * own services; this page supplies the platform data root and permissions.
 */
export default function BaseProfessionalServicesPage() {
  const t = useTranslations('base_professional_services');
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  if (gymLoading || !isSuperadmin) return null;

  return (
    <ProfessionalServicesView
      apiRoot="/platform/professional-services"
      requiresGymStorage={false}
      hasStatus={false}
      requireAllTranslations
      isReadOnlyDefinition={() => false}
      canWrite
      title={t('title')}
      addLabel={t('add')}
      emptyLabel={t('empty')}
    />
  );
}
