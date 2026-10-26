'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { readOnlyStyle } from '@/components/ui';
import { secondaryBtnStyle } from '@/components/formChrome';
import { useToast } from '@/components/Toast';
import { ProfessionalServicesView } from '@/components/professionalServices/ProfessionalServicesView';
import { ImportProfessionalServicesModal } from './ImportProfessionalServicesModal';

/**
 * A gym's Professional Services. All rendering is the shared
 * `ProfessionalServicesView` (#2110); this page supplies the gym's data root,
 * its ORGANIZATION permissions and the Import action.
 */
export default function ProfessionalServicesPage() {
  const t = useTranslations('professional_services');
  const locale = useLocale();
  const router = useRouter();
  const { toast } = useToast();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');
  const [importOpen, setImportOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!gymLoading && !canRead) router.replace(`/${locale}`);
  }, [gymLoading, canRead]);

  if (gymLoading || !canRead) return null;

  return (
    <>
      <ProfessionalServicesView
        apiRoot="/professional-services"
        requiresGymStorage
        hasStatus
        requireAllTranslations={false}
        isReadOnlyDefinition={(item) => Boolean(item.is_system)}
        canWrite={canWrite}
        readOnlyTitle={readOnlyTitle}
        reloadKey={`${activeGymId}:${reloadToken}`}
        title={t('title')}
        addLabel={t('add')}
        emptyLabel={t('empty')}
        headerActions={() => isAdmin && (
          <button onClick={() => setImportOpen(true)} title={readOnlyTitle} style={readOnlyStyle(secondaryBtnStyle, !canWrite)} disabled={!canWrite}>{t('import_services')}</button>
        )}
      />
      <ImportProfessionalServicesModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={(result) => {
          setImportOpen(false);
          toast(t('import_done', { n: result.imported.length }) + (result.skipped.length > 0 ? ` ${t('import_skipped', { n: result.skipped.length })}` : ''));
          setReloadToken((n) => n + 1);
        }}
      />
    </>
  );
}
