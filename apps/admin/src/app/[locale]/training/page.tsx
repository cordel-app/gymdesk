'use client';

/**
 * #2173: Training → Dashboard. Read-only; every figure (adoption %, counts, the
 * Top 5 and its percentages) is the server's (`GET /training/dashboard/summary`).
 * Colours are the active Theme's tokens only.
 */

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { cardSurfaceStyle } from '@/components/ui';

interface TopExercise {
  rank: number;
  exercise_id: number;
  name: string;
  image_thumbnail_url: string | null;
  uses: number;
  percent: number;
}

interface TrainingSummary {
  adoption: { active_members: number; members_with_plan: number; percent: number };
  members_with_active_plans: number;
  active_assignments: number;
  plans_in_use: number;
  avg_exercises_per_plan: number;
  top_exercises: TopExercise[];
}

const muted = 'var(--gd-text-muted, #6b7280)';
const text = 'var(--gd-text, #1a1a2e)';
const accent = 'var(--gd-primary-btn, var(--brand, #6c63ff))';

export default function TrainingDashboard() {
  const t = useTranslations('training_dashboard');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();
  const { canRead } = useModuleAccess('TRAINING');
  const { toast } = useToast();

  const [data, setData] = useState<TrainingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (gymLoading) return;
    if (!canRead) router.replace(`/${locale}`);
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setData(await apiFetch<TrainingSummary>('/training/dashboard/summary'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  const pct = data?.adoption.percent ?? 0;

  return (
    <div>
      <h1 style={{ margin: '0 0 4px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 24px', color: muted, fontSize: 14 }}>{t('subtitle')}</p>

      {loading || !data ? (
        <p style={{ color: muted, fontSize: 14 }}>{t('loading')}</p>
      ) : (
        <>
          <h2 style={sectionTitleStyle}>{t('overview')}</h2>
          <div style={gridStyle}>
            <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 16 }}>
              <div
                role="img"
                aria-label={`${pct}%`}
                style={{
                  width: 72, height: 72, borderRadius: '50%', flexShrink: 0,
                  background: `conic-gradient(${accent} ${pct * 3.6}deg, var(--gd-input-border, #e5e7eb) 0)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <div style={{
                  width: 54, height: 54, borderRadius: '50%', background: 'var(--gd-card-bg, #ffffff)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: text,
                }}>
                  {pct}%
                </div>
              </div>
              <div>
                <div style={labelStyle}>{t('adoption')}</div>
                <div style={{ fontSize: 13, color: muted, marginTop: 4 }}>
                  {t('adoption_detail', { count: data.adoption.members_with_plan, total: data.adoption.active_members })}
                </div>
              </div>
            </div>
            <Kpi label={t('members_with_plans')} value={data.members_with_active_plans} />
            <Kpi label={t('active_assignments')} value={data.active_assignments} />
            <Kpi label={t('plans_in_use')} value={data.plans_in_use} />
            <Kpi label={t('avg_exercises')} value={data.avg_exercises_per_plan} />
          </div>

          <h2 style={{ ...sectionTitleStyle, marginTop: 28 }}>{t('top_exercises')}</h2>
          <div style={{ ...cardStyle, maxWidth: 760 }}>
            {data.top_exercises.length === 0 ? (
              <p style={{ margin: 0, color: muted, fontSize: 14 }}>{t('top_empty')}</p>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 14 }}>
                {data.top_exercises.map((ex) => (
                  <li key={ex.exercise_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ width: 22, textAlign: 'center', fontWeight: ex.rank <= 3 ? 700 : 500, color: ex.rank <= 3 ? accent : muted }}>
                      {ex.rank}
                    </span>
                    {ex.image_thumbnail_url ? (
                      <img src={ex.image_thumbnail_url} alt="" width={40} height={40} style={thumbStyle} />
                    ) : (
                      <span style={{ ...thumbStyle, display: 'inline-block', background: 'var(--gd-input-border, #e5e7eb)' }} />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14 }}>
                        <span style={{ color: text, fontWeight: ex.rank <= 3 ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ex.name}</span>
                        <span style={{ color: muted, whiteSpace: 'nowrap' }}>{t('uses', { count: ex.uses, percent: ex.percent })}</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 4, background: 'var(--gd-input-border, #e5e7eb)', marginTop: 6, overflow: 'hidden' }}>
                        <div style={{ width: `${Math.min(100, ex.percent)}%`, height: '100%', borderRadius: 4, background: accent, opacity: ex.rank <= 3 ? 1 : 0.7, transition: 'width 0.4s ease' }} />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 36, fontWeight: 700, color: text, marginTop: 12, lineHeight: 1.1 }}>{value}</div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: text };
const thumbStyle: React.CSSProperties = { width: 40, height: 40, borderRadius: 8, objectFit: 'cover', flexShrink: 0 };
const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 12px', fontSize: 12, fontWeight: 600, color: 'var(--gd-section-heading-text, #888888)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const gridStyle: React.CSSProperties = { display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' };
const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, padding: '20px 22px' };
