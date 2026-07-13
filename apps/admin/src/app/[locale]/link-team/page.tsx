'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';

interface LinkResponse {
  gym_id: string;
  role: string;
}

export default function LinkTeamPage() {
  const t = useTranslations('team');
  const router = useRouter();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { refreshGyms } = useGym();
  const { toast } = useToast();

  useEffect(() => {
    async function link() {
      try {
        const res = await apiFetch<LinkResponse>('/gym-users/link', {
          method: 'POST',
        });
        // Refresh gym context to get the new gym and role
        if (refreshGyms) {
          await refreshGyms();
        }
        // Redirect to home after successful link
        router.replace(`/${locale}`);
      } catch (err: any) {
        if (err.message?.includes('404')) {
          toast(t('error_no_invitation'));
        } else {
          toast(err.message ?? t('error_generic'));
        }
        // Redirect to home on error
        router.replace(`/${locale}`);
      }
    }
    link();
  }, [router, locale, apiFetch, refreshGyms, toast, t]);

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <p>{t('linking')}</p>
    </div>
  );
}
