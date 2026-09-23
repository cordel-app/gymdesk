'use client';

/**
 * #674: Payments → Dashboard — four counters over the gym's Billing Events.
 *
 * Read-only: the page never writes, so there are no write controls to gate and
 * no Billing Event behaviour is touched. Gated by the `payments.dashboard`
 * feature flag — the sidebar hides the entry and the API 403s, and this page
 * bounces a direct URL so the Dashboard is genuinely unreachable when it is off.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { cardSurfaceStyle } from '@/components/ui';

interface PaymentsDashboardSummary {
  current_month_start: string;
  current_month_end: string;
  previous_month_start: string;
  previous_month_end: string;
  scheduled_this_month: number;
  total_last_month: number;
  failed_last_month: number;
  successful_last_month: number;
}

export default function PaymentsDashboard() {
  const t = useTranslations('payments_dashboard');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, isSuperadmin, loading: gymLoading } = useGym();
  const { isImpersonating } = useImpersonation();
  const { flags, loading: flagsLoading } = useFeatureFlags();
  const { canRead } = useModuleAccess('PAYMENTS');
  const { toast } = useToast();

  const [summary, setSummary] = useState<PaymentsDashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Same rule the sidebar applies (#439): the superadmin flag bypass only holds
  // in native capacity — while impersonating, the impersonated user's flags win.
  const flagEnabled = (isSuperadmin && !isImpersonating)
    || (flags['payments'] !== false && flags['payments.dashboard'] !== false);

  useEffect(() => {
    if (gymLoading || flagsLoading) return;
    if (!canRead || !flagEnabled) router.replace(`/${locale}`);
  }, [gymLoading, flagsLoading, canRead, flagEnabled]);

  useEffect(() => {
    if (!gymLoading && !flagsLoading && canRead && flagEnabled) load();
  }, [activeGymId, gymLoading, flagsLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setSummary(await apiFetch<PaymentsDashboardSummary>('/payments/dashboard/summary'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // "September 2026" in the active locale, from the period the API reports —
  // the card's period label must be the window the numbers were counted over,
  // never a month re-derived in the browser's own time zone.
  const monthLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return (isoDate: string | undefined) => (isoDate ? fmt.format(new Date(`${isoDate}T00:00:00Z`)) : '');
  }, [locale]);

  const cards = summary ? [
    { key: 'scheduled_this_month', value: summary.scheduled_this_month, period: monthLabel(summary.current_month_start) },
    { key: 'total_last_month', value: summary.total_last_month, period: monthLabel(summary.previous_month_start) },
    { key: 'failed_last_month', value: summary.failed_last_month, period: monthLabel(summary.previous_month_start) },
    { key: 'successful_last_month', value: summary.successful_last_month, period: monthLabel(summary.previous_month_start) },
  ] : [];

  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 24px', color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('subtitle')}</p>

      <h2 style={sectionTitleStyle}>{t('billing_events')}</h2>

      {loading ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('loading')}</p>
      ) : !summary ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('empty')}</p>
      ) : (
        <div style={gridStyle}>
          {cards.map((card) => (
            <div key={card.key} style={cardStyle}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--gd-text, #1a1a2e)', wordBreak: 'break-word' }}>
                {t(`card_${card.key}`)}
              </div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 6, textTransform: 'capitalize' }}>
                {card.period}
              </div>
              <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--gd-text, #1a1a2e)', marginTop: 16, lineHeight: 1.1 }}>
                {card.value}
              </div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 4 }}>{t('billing_events_unit')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 12px', fontSize: 12, fontWeight: 600, color: 'var(--gd-section-heading-text, #888888)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};

const gridStyle: React.CSSProperties = {
  display: 'grid', gap: 16,
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
};

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, padding: '20px 22px' };
