'use client';

/**
 * #638: Finance → Dashboard — one card per Membership Plan with the number of
 * Assigned Members on it. Read-only: the page never writes, so there are no
 * write controls and no read-only tooltips to gate.
 */

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';

interface MembershipPlanCard {
  id: number;
  name: string;
  lifecycle_status: string;
  assigned_members: number;
}

export default function FinancialsDashboard() {
  const t = useTranslations('financials_dashboard');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();
  const { canRead } = useModuleAccess('FINANCIALS');
  const { toast } = useToast();

  const [plans, setPlans] = useState<MembershipPlanCard[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (gymLoading) return;
    if (!canRead) { router.replace(`/${locale}`); return; }
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setPlans(await apiFetch<MembershipPlanCard[]>('/financials/dashboard/membership-plans'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 24px', color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('subtitle')}</p>

      <h2 style={sectionTitleStyle}>{t('membership_plans')}</h2>

      {loading ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('loading')}</p>
      ) : plans.length === 0 ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('empty')}</p>
      ) : (
        <div style={gridStyle}>
          {plans.map((plan) => (
            <div key={plan.id} style={cardStyle}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--gd-text, #1a1a2e)', wordBreak: 'break-word' }}>
                {plan.name}
              </div>
              <div style={{ marginTop: 10 }}>
                <StatusBadge status={plan.lifecycle_status} label={tStatus(plan.lifecycle_status)} />
              </div>
              <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--gd-text, #1a1a2e)', marginTop: 16, lineHeight: 1.1 }}>
                {plan.assigned_members}
              </div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 4 }}>{t('assigned_members')}</div>
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

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--gd-card-border, #e2e2e6)',
  borderRadius: 10,
  background: 'var(--gd-card-bg, #ffffff)',
  padding: '20px 22px',
};
