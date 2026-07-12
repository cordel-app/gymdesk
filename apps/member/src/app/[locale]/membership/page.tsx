'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface Benefit {
  benefit_code: string;
  quantity: number | null;
  duration_days: number | null;
  recurrence: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

interface Membership {
  id: number;
  membership_plan_id: number | null;
  base_price: string | null;
  final_price: string | null;
  discount_reason: string | null;
  starts_at: string;
  ends_at: string | null;
  status: 'active' | 'paused' | 'cancelled' | 'expired';
  plan_name: string | null;
  plan_description: string | null;
  benefits: Benefit[];
}

interface UserPackage {
  id: number;
  package_name: string;
  package_sessions: number;
  sessions_remaining: number;
  expires_at: string;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
}

interface BillingEvent {
  id: number;
  event_type: 'charge_created' | 'payment_recorded' | 'status_changed' | 'adjustment';
  charge_type_code: string | null;
  previous_status: string | null;
  new_status: string | null;
  amount: string | null;
  notes: string | null;
  created_at: string;
}

const day = (d: string | null) => (d ? d.slice(0, 10) : null);

export default function MembershipPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [membership, setMembership] = useState<Membership | null>(null);
  const [packages, setPackages] = useState<UserPackage[]>([]);
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const [mship, ledger, pkgs] = await Promise.all([
          apiFetch<{ membership: Membership | null }>('/me/membership'),
          apiFetch<{ items: BillingEvent[] }>('/me/billing-events?limit=50'),
          apiFetch<UserPackage[]>('/me/class-packages').catch(() => []),
        ]);
        if (cancelled) return;
        setMembership(mship.membership);
        setEvents(ledger.items);
        setPackages(pkgs);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale]);

  if (loading) {
    return (
      <main style={styles.container}>
        <p style={styles.hint}>{t('membership.loading')}</p>
      </main>
    );
  }

  if (error) {
    return (
      <main style={styles.container}>
        <p style={{ ...styles.hint, color: '#c0392b' }}>{error}</p>
      </main>
    );
  }

  if (!membership) {
    return (
      <main style={styles.container}>
        <div style={styles.emptyCard}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
          <h1 style={styles.emptyTitle}>{t('membership.title')}</h1>
          <p style={styles.hint}>{t('membership.empty')}</p>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('membership.title')}</h1>

      <div style={styles.card}>
        <div style={styles.cardHead}>
          <div>
            <p style={styles.planName}>{membership.plan_name ?? '—'}</p>
            {membership.plan_description && (
              <p style={styles.planDesc}>{membership.plan_description}</p>
            )}
          </div>
          <StatusPill status={membership.status} label={t(`membership.status.${membership.status}`)} />
        </div>

        <dl style={styles.dl}>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.price')}</dt>
            <dd style={styles.dd}>
              {membership.final_price ? parseFloat(membership.final_price).toFixed(2) : '—'}
              {membership.discount_reason && (
                <span style={styles.discount}> · {membership.discount_reason}</span>
              )}
            </dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.starts')}</dt>
            <dd style={styles.dd}>{day(membership.starts_at) ?? '—'}</dd>
          </div>
          <div style={styles.row}>
            <dt style={styles.dt}>{t('membership.ends')}</dt>
            <dd style={styles.dd}>{day(membership.ends_at) ?? t('membership.ongoing')}</dd>
          </div>
        </dl>
      </div>

      {membership.benefits.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('membership.benefits_heading')}</h2>
          <ul style={styles.benefitList}>
            {membership.benefits.map((b, i) => (
              <li key={i} style={styles.benefitItem}>
                <span>{t(`membership.benefit.${b.benefit_code}`)}</span>
                {b.quantity != null && (
                  <span style={styles.benefitMeta}>× {b.quantity}</span>
                )}
                {b.recurrence && (
                  <span style={styles.benefitMeta}>· {t(`membership.recurrence.${b.recurrence}`)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {packages.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>{t('membership.packages_heading')}</h2>
          <ul style={styles.eventList}>
            {packages.map((p) => (
              <li key={p.id} style={styles.eventItem}>
                <div style={styles.eventLine}>
                  <span style={styles.eventLabel}>{p.package_name}</span>
                  <span style={styles.eventAmount}>
                    {p.sessions_remaining} / {p.package_sessions}
                  </span>
                </div>
                <div style={styles.eventSub}>
                  {t(`membership.package_status.${p.status}`)}
                  {p.status === 'active' && ` · ${t('membership.expires', { date: p.expires_at.slice(0, 10) })}`}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={styles.section}>
        <h2 style={styles.h2}>{t('membership.history_heading')}</h2>
        {events.length === 0 ? (
          <p style={styles.hint}>{t('membership.history_empty')}</p>
        ) : (
          <ul style={styles.eventList}>
            {events.map((e) => (
              <li key={e.id} style={styles.eventItem}>
                <div style={styles.eventLine}>
                  <span style={styles.eventLabel}>
                    {t(`membership.event.${e.event_type}`)}
                    {e.charge_type_code && ` · ${t(`membership.charge_type.${e.charge_type_code}`)}`}
                  </span>
                  {e.amount && (
                    <span style={styles.eventAmount}>{parseFloat(e.amount).toFixed(2)}</span>
                  )}
                </div>
                <div style={styles.eventSub}>
                  <span>{e.created_at.slice(0, 10)}</span>
                  {e.event_type === 'status_changed' && e.new_status && (
                    <span>
                      {' · '}
                      {e.previous_status ? t(`membership.status.${e.previous_status}`) : '—'}
                      {' → '}
                      {t(`membership.status.${e.new_status}`)}
                    </span>
                  )}
                  {e.notes && <span> · {e.notes}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const COLORS: Record<string, { bg: string; fg: string }> = {
    active:    { bg: '#e6f6ec', fg: '#1e7e40' },
    paused:    { bg: '#fff4e0', fg: '#b26a00' },
    cancelled: { bg: '#fdeaea', fg: '#c0392b' },
    expired:   { bg: '#f3eafd', fg: '#7d3cbd' },
  };
  const c = COLORS[status] ?? { bg: '#f0f0f0', fg: '#666' };
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: '4px 12px', fontSize: 12, fontWeight: 600 }}>
      {label}
    </span>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  card: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  planName: { margin: 0, fontSize: 20, fontWeight: 700, color: '#18181b' },
  planDesc: { margin: '4px 0 0', fontSize: 13, color: '#71717a' },
  dl: { margin: 0 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid #f0f0f0' },
  dt: { margin: 0, fontSize: 13, color: '#71717a' },
  dd: { margin: 0, fontSize: 15, color: '#18181b', fontWeight: 500 },
  discount: { fontSize: 12, color: '#b26a00', fontWeight: 400 },
  section: { marginTop: 24 },
  h2: { margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: '#18181b' },
  benefitList: { listStyle: 'none', padding: 0, margin: 0 },
  benefitItem: { background: '#fff', borderRadius: 8, padding: '10px 14px', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' },
  benefitMeta: { fontSize: 13, color: '#71717a' },
  eventList: { listStyle: 'none', padding: 0, margin: 0 },
  eventItem: { background: '#fff', borderRadius: 8, padding: '12px 14px', marginBottom: 6 },
  eventLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  eventLabel: { fontSize: 14, fontWeight: 500, color: '#18181b' },
  eventAmount: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  eventSub: { fontSize: 12, color: '#71717a', marginTop: 4 },
  emptyCard: { background: '#fff', borderRadius: 12, padding: '40px 24px', textAlign: 'center' },
  emptyTitle: { margin: '8px 0 12px', fontSize: 20, fontWeight: 700 },
  hint: { color: '#71717a', fontSize: 14, textAlign: 'center', margin: 0 },
};
