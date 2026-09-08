'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth, useSignUp } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';

const ACTIVE_GYM_KEY = 'activeGymId';

export default function LinkPage() {
  const t = useTranslations('link');
  const router = useRouter();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const { signUp } = useSignUp();
  const { apiFetch } = useApiClient();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    // Wait for Clerk's client to initialize before touching any of its APIs.
    if (!isLoaded) return;
    if (ranRef.current) return;
    ranRef.current = true;

    const gymId = searchParams.get('gym_id');
    const ticket = searchParams.get('__clerk_ticket');

    async function redeemTicket() {
      if (!ticket) return false;
      // Clerk does NOT auto-process an invitation ticket just because it's
      // present in the URL — the app must explicitly redeem it.
      const { error } = await signUp.ticket({ ticket });
      if (error || signUp.status !== 'complete') return false;
      const { error: finalizeError } = await signUp.finalize({
        // No-op: we want to stay on this page and call /me/link ourselves
        // before navigating, not let Clerk redirect first.
        navigate: () => {},
      });
      return !finalizeError;
    }

    async function link() {
      if (!gymId) {
        setError(t('error_no_invitation'));
        setTimeout(() => router.replace(`/${locale}`), 2000);
        return;
      }

      if (!isSignedIn) {
        const redeemed = await redeemTicket();
        if (!redeemed) {
          setError(t('error_generic'));
          setTimeout(() => router.replace(`/${locale}/sign-in`), 1500);
          return;
        }
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
  }, [isLoaded, isSignedIn, signUp, router, locale, searchParams, apiFetch, t]);

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <p>{error ?? t('linking')}</p>
    </div>
  );
}
