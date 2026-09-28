'use client';

/**
 * #809: Nutrition → Dashboard — one card per Nutrition Plan Template with the
 * number of active members who hold a Nutrition Plan created from it, plus the
 * bucket card for plans created from scratch. Read-only: the page never writes,
 * so there are no write controls and no read-only tooltips to gate.
 *
 * The visible numbers are the server's (`GET /nutrition/dashboard/nutrition-plans`)
 * — which Templates qualify and who counts as an active member is decided there,
 * never re-derived here.
 */

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { cardSurfaceStyle } from '@/components/ui';

interface NutritionPlanCard {
  template_id: number | null;
  name: string | null;
  status: string | null;
  active_members: number;
}

export default function NutritionDashboard() {
  const t = useTranslations('nutrition_dashboard');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();
  const { canRead } = useModuleAccess('NUTRITION');
  const { toast } = useToast();

  const [cards, setCards] = useState<NutritionPlanCard[]>([]);
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
      setCards(await apiFetch<NutritionPlanCard[]>('/nutrition/dashboard/nutrition-plans'));
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

      <h2 style={sectionTitleStyle}>{t('nutrition_plans')}</h2>

      {loading ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('loading')}</p>
      ) : cards.length === 0 ? (
        <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 14 }}>{t('empty')}</p>
      ) : (
        <div style={gridStyle}>
          {cards.map((card) => (
            <div key={card.template_id ?? 'no-template'} style={cardStyle}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--gd-text, #1a1a2e)', wordBreak: 'break-word' }}>
                {card.name ?? t('no_template')}
              </div>
              <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--gd-text, #1a1a2e)', marginTop: 16, lineHeight: 1.1 }}>
                {card.active_members}
              </div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 4 }}>{t('active_members')}</div>
              <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)', marginTop: 16 }}>{t('template_status')}</div>
              <div style={{ marginTop: 6 }}>
                {/* The bucket card has no Template, so it has no Template status either (#809). */}
                {card.status
                  ? <StatusBadge status={card.status} label={tStatus(card.status)} />
                  : <span style={{ fontSize: 14, color: 'var(--gd-text-muted, #6b7280)' }}>—</span>}
              </div>
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
