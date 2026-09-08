'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';

const ACTIVE_GYM_KEY = 'activeGymId';

export default function LinkPage() {
  const t = useTranslations('link');
  const router = useRouter();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const gymId = searchParams.get('gym_id');

    async function link() {
      if (!gymId) {
        setError(t('error_no_invitation'));
        setTimeout(() => router.replace(`/${locale}`), 2000);
        return;
      }

      try {
        await apiFetch('/me/link', {
          method: 'POST',
          headers: { 'x-gym-id': gymId },
        });
        localStorage.setItem(ACTIVE_GYM_KEY, gymId);
        router.replace(`/${locale}`);
      } catch (err: any) {
        setError(err.message?.includes('404') ? t('error_no_invitation') : t('error_generic'));
        setTimeout(() => router.replace(`/${locale}`), 2000);
      }
    }

    link();
  }, [router, locale, searchParams, apiFetch, t]);

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <p>{error ?? t('linking')}</p>
    </div>
  );
}
