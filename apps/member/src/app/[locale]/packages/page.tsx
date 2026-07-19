'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface ClassPackage {
  id: number;
  package_name: string;
  package_sessions: number;
  sessions_remaining: number;
  expires_at: string;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
}

function dateOnly(iso: string) { return iso.slice(0, 10); }

export default function PackagesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [packages, setPackages] = useState<ClassPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pastExpanded, setPastExpanded] = useState(false);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<ClassPackage[]>('/me/class-packages');
        if (!cancelled) setPackages(data);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale]);

  const active = packages.filter((p) => p.status === 'active');
  const past = packages.filter((p) => p.status !== 'active');
  const totalCredits = active.reduce((sum, p) => sum + p.sessions_remaining, 0);

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('packages.loading')}</p></main>;
  }

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: '#c0392b' }}>{error}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('packages.title')}</h1>

      {active.length === 0 ? (
        <div style={styles.emptyCard}>
          <p style={styles.emptyIcon}>📦</p>
          <p style={styles.emptyText}>{t('packages.empty')}</p>
          <p style={styles.hint}>{t('packages.empty_hint')}</p>
        </div>
      ) : (
        <>
          {/* Credit summary chip */}
          <div style={styles.summaryChip}>
            <span style={styles.summaryCount}>{totalCredits}</span>
            <span style={styles.summaryLabel}>{t('packages.total_credits')}</span>
          </div>

          <ul style={styles.list}>
            {active.map((p) => (
              <li key={p.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.packageName}>{p.package_name}</span>
                  <span style={styles.activePill}>{t('packages.status_active')}</span>
                </div>
                <div style={styles.creditsRow}>
                  <span style={styles.creditsCount}>{p.sessions_remaining}</span>
                  <span style={styles.creditsOf}>/ {p.package_sessions} {t('packages.sessions')}</span>
                </div>
                <div style={styles.progressBar}>
                  <div
                    style={{
                      ...styles.progressFill,
                      width: `${Math.round((p.sessions_remaining / p.package_sessions) * 100)}%`,
                    }}
                  />
                </div>
                <p style={styles.expiry}>
                  {t('packages.expires_on', { date: dateOnly(p.expires_at) })}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {past.length > 0 && (
        <section style={styles.pastSection}>
          <button style={styles.pastToggle} onClick={() => setPastExpanded((v) => !v)}>
            {pastExpanded ? '▾' : '▸'} {t('packages.past_heading')} ({past.length})
          </button>
          {pastExpanded && (
            <ul style={styles.list}>
              {past.map((p) => (
                <li key={p.id} style={{ ...styles.card, opacity: 0.6 }}>
                  <div style={styles.cardHead}>
                    <span style={styles.packageName}>{p.package_name}</span>
                    <span style={styles.pastPill}>{t(`packages.status_${p.status}`)}</span>
                  </div>
                  <p style={styles.hint}>
                    {p.sessions_remaining} / {p.package_sessions} {t('packages.sessions')} · {dateOnly(p.expires_at)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:     { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:         { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  summaryChip:   { display: 'inline-flex', alignItems: 'center', gap: 8, background: '#18181b', color: '#fff', borderRadius: 999, padding: '8px 18px', marginBottom: 20 },
  summaryCount:  { fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  summaryLabel:  { fontSize: 14, fontWeight: 500 },
  list:          { listStyle: 'none', padding: 0, margin: 0 },
  card:          { background: '#fff', borderRadius: 12, padding: '16px 18px', marginBottom: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHead:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 },
  packageName:   { fontSize: 16, fontWeight: 600, color: '#18181b' },
  activePill:    { background: '#e6f6ec', color: '#1e7e40', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  pastPill:      { background: '#f0f0f0', color: '#666', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' },
  creditsRow:    { display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 8 },
  creditsCount:  { fontSize: 32, fontWeight: 800, color: '#18181b', fontVariantNumeric: 'tabular-nums' },
  creditsOf:     { fontSize: 14, color: '#71717a' },
  progressBar:   { height: 6, background: '#f0f0f0', borderRadius: 999, overflow: 'hidden', marginBottom: 8 },
  progressFill:  { height: '100%', background: '#18181b', borderRadius: 999, transition: 'width 0.3s' },
  expiry:        { margin: 0, fontSize: 13, color: '#71717a' },
  pastSection:   { marginTop: 24 },
  pastToggle:    { background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#71717a', padding: '4px 0', marginBottom: 10 },
  emptyCard:     { background: '#fff', borderRadius: 12, padding: '40px 24px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  emptyIcon:     { fontSize: 40, margin: '0 0 12px' },
  emptyText:     { margin: '0 0 8px', fontSize: 16, fontWeight: 600, color: '#18181b' },
  hint:          { color: '#71717a', fontSize: 13, margin: 0 },
};
