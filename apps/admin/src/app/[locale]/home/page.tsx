'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useUser } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useFeatureFlags } from '@/context/FeatureFlagsContext';
import { canWriteFeature, canWriteModule } from '@/config/permissions';
import { MemberCommunicationModal } from '../members/MemberCommunicationModal';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDate, formatGymTime } from '@/lib/gymFormat';
import { cardSurfaceStyle } from '@/components/ui';
import { StatusBadge } from '@/components/StatusBadge';
import { secondaryBtnSmall, cardMutedTextStyle as mutedTextStyle } from '@/components/formChrome';
import {
  HomeData, TASK_ACTION_KEY, memberHref, orderedTasks, shiftDate, taskHref,
} from '@/lib/homeDashboard';

// #1367 — Home. One request (`GET /dashboard/home`) feeds every section; the
// date arrows refetch it. Sections the caller's role may not read are absent
// from the response and therefore from the page.

const cardsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 16, marginBottom: 20 };
const panelsGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' };
const panel: React.CSSProperties = { ...cardSurfaceStyle, padding: 20 };
const panelTitle: React.CSSProperties = { margin: '0 0 12px', fontSize: 16, fontWeight: 700 };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--gd-border, #e5e7eb)' };
const linkStyle: React.CSSProperties = { color: 'var(--gd-link, #2563eb)', fontSize: 13, textDecoration: 'none', whiteSpace: 'nowrap' };

function SummaryCard({ label, value, sub, href }: { label: string; value: string; sub: string; href?: string }) {
  const body = (
    <div style={{ ...cardSurfaceStyle, padding: 18, height: '100%' }}>
      <div style={{ fontSize: 13, color: 'var(--gd-text-muted, #6b7280)' }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, margin: '6px 0 4px' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{sub}</div>
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</Link> : body;
}

export default function HomePage() {
  const t = useTranslations('home');
  const tm = useTranslations('members');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin } = useGym();
  const { flags: featureFlags } = useFeatureFlags();
  const [welcomeFor, setWelcomeFor] = useState<{ id: number; name: string } | null>(null);
  // Same gate as Members → ⋮ → Send communication, plus MEMBERS write because a
  // sent welcome also stamps `welcomed_at` (PUT /members/:id/welcomed).
  const canWelcomeHere = (isSuperadmin
    || (activeGym?.role != null
      && canWriteFeature(activeGym.role, 'MEMBERS', 'membership.staff_communications')
      && canWriteModule(activeGym.role, 'MEMBERS')))
    && featureFlags['membership.staff_communications'] !== false;
  const { user } = useUser();
  const fmt = useGymFormatSettings();
  const [date, setDate] = useState<string | null>(null);
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: string | null) => {
    if (!activeGymId) return;
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch<HomeData>(`/dashboard/home${d ? `?date=${d}` : ''}`);
      setData(res);
      setDate(res.date);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [activeGymId, apiFetch]);

  useEffect(() => { load(null); }, [activeGymId]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (days: number) => date && load(shiftDate(date, days));
  const name = user?.firstName ?? user?.fullName ?? null;
  const tasks = data ? orderedTasks(data.tasks) : [];
  const c = data?.cards;

  return (
    <div style={{ padding: 24, maxWidth: 1200 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>{name ? t('greeting', { name }) : t('greeting_anonymous')}</h1>
          <p style={{ ...mutedTextStyle, margin: '4px 0 0' }}>{t('intro')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" style={secondaryBtnSmall} onClick={() => go(-1)} disabled={!date || loading} aria-label={t('prev_day')}>‹</button>
          <strong data-testid="home-date" style={{ minWidth: 110, textAlign: 'center' }}>{date ? formatGymDate(`${date}T12:00:00Z`, { ...fmt, time_zone: 'UTC' }) : '—'}</strong>
          <button type="button" style={secondaryBtnSmall} onClick={() => go(1)} disabled={!date || loading} aria-label={t('next_day')}>›</button>
          {data && date !== data.today && (
            <button type="button" style={secondaryBtnSmall} onClick={() => load(data.today)} disabled={loading}>{t('today')}</button>
          )}
        </div>
      </header>

      {error && <p style={mutedTextStyle}>{t('error')}</p>}
      {!data && loading && <p style={mutedTextStyle}>{t('loading')}</p>}

      {data && (
        <>
          {data.pending_payment_members && (
            <section style={{ ...panel, marginBottom: 20 }} aria-label={t('pending_title')} data-testid="home-pending-payments">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ ...panelTitle, margin: 0 }}>{t('pending_title')}</h2>
                <strong style={{ fontSize: 26 }} data-testid="home-pending-count">{data.pending_payment_members.count}</strong>
                <span style={mutedTextStyle}>{t('pending_sub', { count: data.pending_payment_members.count })}</span>
              </div>
              {data.pending_payment_members.members.length === 0 ? (
                <p style={{ ...mutedTextStyle, margin: '12px 0 0' }}>{t('pending_empty')}</p>
              ) : (
                <div style={{ marginTop: 12 }}>
                  {data.pending_payment_members.members.map((m) => (
                    <div key={m.member_id} style={row} data-testid={`home-pending-${m.member_id}`}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Link href={memberHref(m.member_id, locale, 'profile')} style={{ color: 'inherit', fontWeight: 600 }}>{m.name}</Link>
                        <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{m.plan_name ?? t('members_plan_none')}</div>
                      </div>
                      <strong>{formatGymAmount(m.outstanding_amount, fmt)}</strong>
                      <StatusBadge status={m.payment_status} label={tm(`payment_status_${m.payment_status}`)} />
                    </div>
                  ))}
                </div>
              )}
              {data.pending_payment_members.count > data.pending_payment_members.members.length && (
                <p style={{ margin: '12px 0 0' }}>
                  <Link href={taskHref('payments_with_issues', locale)} style={linkStyle}>{t('pending_view_all', { count: data.pending_payment_members.count })}</Link>
                </p>
              )}
            </section>
          )}

          <div style={cardsGrid}>
            {c?.active_members && (
              <SummaryCard label={t('card_active_members')} value={String(c.active_members.count)}
                sub={t('card_active_members_sub', { count: c.active_members.joined_this_week })}
                href={`/${locale}/members?enrollment_status=active`} />
            )}
            {c?.new_members && (
              <SummaryCard label={t('card_new_members')} value={String(c.new_members.count)}
                sub={t('card_new_members_sub')} href={`/${locale}/members`} />
            )}
            {c?.classes_today && (
              <SummaryCard label={t('card_classes')} value={`${c.classes_today.count} / ${c.classes_today.total}`}
                sub={t('card_classes_sub', { count: c.classes_today.waitlist_total })} href={`/${locale}/calendar`} />
            )}
            {c?.outstanding_payments && (
              <SummaryCard label={t('card_payments')} value={formatGymAmount(c.outstanding_payments.amount, fmt)}
                sub={t('card_payments_sub', { count: c.outstanding_payments.count, paid: c.outstanding_payments.paid_count })}
                href={taskHref('payments_with_issues', locale)} />
            )}
          </div>

          <section style={{ ...panel, marginBottom: 16 }} aria-label={t('tasks_title')}>
            <h2 style={panelTitle}>{t('tasks_title')}</h2>
            {tasks.length === 0 ? (
              <p style={{ ...mutedTextStyle, margin: 0 }} data-testid="home-all-clear">{t('tasks_all_clear')}</p>
            ) : tasks.map((task) => (
              <div key={task.key} style={row} data-testid={`home-task-${task.key}`}>
                <div>
                  <div>{t(`task_${task.key}`, { count: task.count, people: task.secondary ?? 0 })}</div>
                  {task.samples && task.samples.length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      {task.samples.map((s, i) => (
                        <span key={s.id}>
                          {i > 0 && ', '}
                          <Link href={memberHref(s.id, locale)} style={{ color: 'inherit' }}>{s.name}{s.detail ? ` (${s.detail})` : ''}</Link>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {task.key === 'welcome_new_members' && canWelcomeHere && task.samples && task.samples.length > 0 ? (
                  <button type="button" style={{ ...linkStyle, background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                    onClick={() => setWelcomeFor(task.samples![0])}>{t(TASK_ACTION_KEY[task.key])}</button>
                ) : (
                  <Link href={taskHref(task.key, locale)} style={linkStyle}>{t(TASK_ACTION_KEY[task.key])}</Link>
                )}
              </div>
            ))}
          </section>

          <div style={panelsGrid}>
            {data.classes && (
              <section style={panel} aria-label={t('classes_title')}>
                <h2 style={panelTitle}>{t('classes_title')}</h2>
                {data.classes.length === 0 ? (
                  <p style={{ ...mutedTextStyle, margin: 0 }}>{t('classes_empty')}</p>
                ) : data.classes.map((k) => (
                  <div key={k.id} style={row}>
                    <div>
                      <strong>{formatGymTime(k.starts_at, fmt)}</strong> {k.name}
                    </div>
                    <div style={{ fontSize: 13, textAlign: 'right' }}>
                      {k.booked_count}{k.capacity != null ? `/${k.capacity}` : ''}
                      {k.waitlist_count > 0 && <div style={{ fontSize: 12 }}>{t('class_waitlist', { count: k.waitlist_count })}</div>}
                    </div>
                  </div>
                ))}
                <p style={{ margin: '12px 0 0' }}><Link href={`/${locale}/calendar`} style={linkStyle}>{t('classes_view_all')}</Link></p>
              </section>
            )}
            {data.latest_members && (
              <section style={panel} aria-label={t('members_title')}>
                <h2 style={panelTitle}>{t('members_title')}</h2>
                {data.latest_members.length === 0 ? (
                  <p style={{ ...mutedTextStyle, margin: 0 }}>{t('members_empty')}</p>
                ) : data.latest_members.map((m) => (
                  <div key={m.id} style={{ ...row, justifyContent: 'flex-start' }}>
                    {m.image_url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={m.image_url} alt="" width={36} height={36} style={{ borderRadius: '50%', objectFit: 'cover' }} />
                      : <span aria-hidden style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--gd-border, #e5e7eb)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>{m.name.trim().charAt(0).toUpperCase()}</span>}
                    <div style={{ flex: 1 }}>
                      <Link href={memberHref(m.id, locale, 'profile')} style={{ color: 'inherit', fontWeight: 600 }}>{m.name}</Link>
                      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{m.plan_name ?? t('members_plan_none')}</div>
                    </div>
                    <span style={{ fontSize: 12 }}>{formatGymDate(m.created_at, fmt)}</span>
                  </div>
                ))}
                <p style={{ margin: '12px 0 0' }}><Link href={`/${locale}/members`} style={linkStyle}>{t('members_view_all')}</Link></p>
              </section>
            )}
          </div>
        </>
      )}
      {welcomeFor && (
        <MemberCommunicationModal
          memberId={welcomeFor.id}
          memberName={welcomeFor.name}
          onClose={() => setWelcomeFor(null)}
          onSent={async () => {
            // The task counts `welcomed_at IS NULL`, so a sent welcome stamps it
            // and the refetch drops this member (and only this member).
            try { await apiFetch(`/members/${welcomeFor.id}/welcomed`, { method: 'PUT', body: JSON.stringify({ welcomed: true }) }); } catch { /* task simply stays */ }
            load(date);
          }}
        />
      )}
    </div>
  );
}
