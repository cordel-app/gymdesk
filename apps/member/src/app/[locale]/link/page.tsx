'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth, useSignUp } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';

const ACTIVE_GYM_KEY = 'activeGymId';

type Phase = 'linking' | 'needs_password' | 'error';

export default function LinkPage() {
  const t = useTranslations('link');
  const router = useRouter();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const { signUp } = useSignUp();
  const { apiFetch } = useApiClient();
  const [phase, setPhase] = useState<Phase>('linking');
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ranRef = useRef(false);
  const gymId = searchParams.get('gym_id');

  async function finishLink() {
    if (!gymId) {
      setPhase('error');
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
      setPhase('error');
      setError(err.message?.includes('404') ? t('error_no_invitation') : t('error_generic'));
      setTimeout(() => router.replace(`/${locale}`), 2000);
    }
  }

  async function finalizeSignUp() {
    const { error: finalizeError } = await signUp.finalize({
      // No-op: we want to call /me/link and navigate ourselves, not let
      // Clerk's default redirect fire first.
      navigate: () => {},
    });
    if (finalizeError) {
      setPhase('error');
      setError(t('error_generic'));
      setTimeout(() => router.replace(`/${locale}/sign-in`), 1500);
      return;
    }
    await finishLink();
  }

  useEffect(() => {
    if (!isLoaded) return;
    if (ranRef.current) return;
    ranRef.current = true;

    const ticket = searchParams.get('__clerk_ticket');

    async function start() {
      if (!gymId) {
        setPhase('error');
        setError(t('error_no_invitation'));
        setTimeout(() => router.replace(`/${locale}`), 2000);
        return;
      }

      if (isSignedIn) {
        await finishLink();
        return;
      }

      if (!ticket) {
        setPhase('error');
        setError(t('error_generic'));
        setTimeout(() => router.replace(`/${locale}/sign-in`), 1500);
        return;
      }

      // Clerk does NOT auto-process an invitation ticket just because it's
      // present in the URL — the app must explicitly redeem it.
      const { error: ticketError } = await signUp.ticket({ ticket });
      if (ticketError) {
        setPhase('error');
        setError(t('error_generic'));
        setTimeout(() => router.replace(`/${locale}/sign-in`), 1500);
        return;
      }

      if (signUp.status === 'complete') {
        await finalizeSignUp();
        return;
      }

      // This instance requires a password to complete sign-up — a ticket
      // alone only verifies the invited email address.
      if (signUp.status === 'missing_requirements' && signUp.missingFields.includes('password')) {
        setPhase('needs_password');
        return;
      }

      setPhase('error');
      setError(t('error_generic'));
      setTimeout(() => router.replace(`/${locale}/sign-in`), 1500);
    }

    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn]);

  async function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);

    if (password.length < 8) {
      setPasswordError(t('password_too_short'));
      return;
    }
    if (password !== confirmPassword) {
      setPasswordError(t('password_mismatch'));
      return;
    }

    setSubmitting(true);
    try {
      // Redeem the ticket again together with the password. Never send
      // emailAddress here: re-sending it replaces the address the ticket
      // verified, leaving the sign-up stuck on an unverified email.
      const { error: passwordSetError } = await signUp.create({
        strategy: 'ticket',
        ticket: searchParams.get('__clerk_ticket') ?? undefined,
        password,
      });
      if (passwordSetError) {
        setPasswordError(passwordSetError.message ?? t('error_generic'));
        setSubmitting(false);
        return;
      }
      if (signUp.status !== 'complete') {
        setPasswordError(t('error_generic'));
        setSubmitting(false);
        return;
      }
      await finalizeSignUp();
    } catch {
      setPasswordError(t('error_generic'));
      setSubmitting(false);
    }
  }

  if (phase === 'needs_password') {
    return (
      <div style={{ maxWidth: 360, margin: '60px auto', padding: '0 20px' }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>{t('set_password_title')}</h1>
        <p style={{ color: '#666', marginBottom: 24 }}>{t('set_password_hint')}</p>
        <form onSubmit={handlePasswordSubmit}>
          <label style={{ display: 'block', marginBottom: 4 }}>{t('password_label')}</label>
          <PasswordInput
            value={password}
            onChange={setPassword}
            showLabel={t('show_password')}
            hideLabel={t('hide_password')}
          />
          <label style={{ display: 'block', marginBottom: 4 }}>{t('confirm_password_label')}</label>
          <PasswordInput
            value={confirmPassword}
            onChange={setConfirmPassword}
            showLabel={t('show_password')}
            hideLabel={t('hide_password')}
          />
          {passwordError && <p style={{ color: '#c0392b', marginBottom: 16 }}>{passwordError}</p>}
          <button type="submit" disabled={submitting} style={{ width: '100%', padding: 12 }}>
            {submitting ? t('submitting') : t('submit')}
          </button>
        </form>
        <div id="clerk-captcha" />
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
      <p>{error ?? t('linking')}</p>
      {/* Required mount point for Clerk's bot-protection CAPTCHA — sign-up
          (including ticket-based) fails with a captcha_invalid error without it. */}
      <div id="clerk-captcha" />
    </div>
  );
}

// A password field with an eye button that toggles the characters visible.
function PasswordInput({ value, onChange, showLabel, hideLabel }: {
  value: string;
  onChange: (value: string) => void;
  showLabel: string;
  hideLabel: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative', marginBottom: 16 }}>
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        style={{ width: '100%', padding: '10px 44px 10px 10px', boxSizing: 'border-box' }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        title={visible ? hideLabel : showLabel}
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 40,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#666',
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {visible && <line x1="3" y1="3" x2="21" y2="21" />}
        </svg>
      </button>
    </div>
  );
}
