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
import { ClassCommunicationModal } from '../calendar/ClassCommunicationModal';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { formatGymAmount, formatGymDate, formatGymNumber, formatGymTime } from '@/lib/gymFormat';
import { primaryBtnSmall } from '@/components/ui';
import {
  Avatar, CountBadge, HomeHeader, HomeTone, METRIC_ICONS, Panel, SummaryCard, ToneIcon, cardsGrid, homeFocusCss, linkStyle, panelsGrid, rowStyle as row,
} from '@/components/home/HomeParts';
import { StatusBadge } from '@/components/StatusBadge';
import { InlineStyle } from '@/components/InlineStyle';
import { secondaryBtnSmall, cardMutedTextStyle as mutedTextStyle } from '@/components/formChrome';
import { CheckIcon } from '@/components/home/HomeIcons';
import {
  HomeData, TASK_ACTION_KEY, canStartClass, memberHref, orderedTasks, quickActionHref, startClassHref, taskHref,
  type HomeTaskKey, type QuickActionKey,
} from '@/lib/homeDashboard';

// #1367 / #1754 — Home. One request (`GET /dashboard/home`) feeds every section
// and always describes today in the gym's zone (no date navigation). Sections
// the caller's role may not read are absent from the response and therefore
// from the page.

const TASK_TONE: Record<HomeTaskKey, HomeTone> = {
  events_without_space: 'classes',
  events_without_trainer: 'classes',
  welcome_new_members: 'growth',
  services_not_scheduled: 'members',
  events_with_waitlist: 'classes',
  payments_with_issues: 'payments',
};

export default function HomePage() {
  const t = useTranslations('home');
  const tm = useTranslations('members');
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin } = useGym();
  const { flags: featureFlags } = useFeatureFlags();
  const motivationalSentence = ((activeGym?.theme?.tokens as { motivationalSentence?: unknown } | undefined)?.motivationalSentence);
  const sentence = typeof motivationalSentence === 'string' ? motivationalSentence.trim() : '';
  const [welcomeFor, setWelcomeFor] = useState<{ id: number; name: string } | null>(null);
  const [messageClass, setMessageClass] = useState<{ id: number; name: string } | null>(null);
  const tc = useTranslations('calendar');
  const { canWrite: canWriteCalendar } = useModuleAccess('CALENDAR');
  const { canWrite: canMessageClass } = useModuleAccess('CALENDAR', 'calendar.staff_communications');
  const canWriteMembers = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'MEMBERS'));
  const classMessagingOn = canMessageClass && featureFlags['calendar.staff_communications'] !== false && featureFlags['calendar'] !== false;
  // Same gate as Members → ⋮ → Send communication, plus MEMBERS write because a
  // sent welcome also stamps `welcomed_at` (PUT /members/:id/welcomed).
  const canWelcomeHere = (isSuperadmin
    || (activeGym?.role != null
      && canWriteFeature(activeGym.role, 'MEMBERS', 'membership.staff_communications')
      && canWriteModule(activeGym.role, 'MEMBERS')))
    && featureFlags['membership.staff_communications'] !== false;
  const { user } = useUser();
  const fmt = useGymFormatSettings();
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeGymId) return;
    setLoading(true);
    setError(false);
    try {
      const res = await apiFetch<HomeData>('/dashboard/home');
      setData(res);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [activeGymId, apiFetch]);

  useEffect(() => { load(); }, [activeGymId]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = user?.firstName ?? user?.fullName ?? null;
  const tasks = data ? orderedTasks(data.tasks) : [];
  const c = data?.cards;
  const quickActions: { key: QuickActionKey }[] = [
    ...(data?.access.members && canWriteMembers ? [{ key: 'add_member' as const }] : []),
    ...(data?.access.members ? [{ key: 'manage_member' as const }] : []),
    ...(data?.access.classes && canWriteCalendar ? [{ key: 'new_class' as const }] : []),
    ...(data?.access.payments ? [{ key: 'review_payments' as const }] : []),
  ];

  const classMinutes = (k: { starts_at: string; ends_at: string }) =>
    Math.max(1, Math.round((new Date(k.ends_at).getTime() - new Date(k.starts_at).getTime()) / 60000));

  return (
    <div style={{ padding: 24, maxWidth: 1240 }}>
      <InlineStyle css={homeFocusCss} />
      <HomeHeader
        greeting={name ? t('greeting', { name }) : t('greeting_anonymous')}
        intro={t('intro')}
        sentence={sentence}
      />

      {error && <p style={mutedTextStyle}>{t('error')}</p>}
      {!data && loading && <p style={mutedTextStyle}>{t('loading')}</p>}

      {data && (
        <>
          <div style={cardsGrid}>
            {c?.active_members && (
              <SummaryCard {...METRIC_ICONS.active_members} label={t('card_active_members')} value={String(c.active_members.count)}
                sub={t('card_active_members_sub', { count: c.active_members.joined_this_week })}
                href={`/${locale}/members?enrollment_status=active`} />
            )}
            {c?.new_members && (
              <SummaryCard {...METRIC_ICONS.new_members} label={t('card_new_members')} value={String(c.new_members.count)}
                sub={t('card_new_members_sub')} hint={t('card_new_members_hint')} href={`/${locale}/members`} />
            )}
            {c?.classes_today && (
              <SummaryCard {...METRIC_ICONS.classes} label={t('card_classes')} value={`${c.classes_today.count} / ${c.classes_today.total}`}
                sub={t('card_classes_sub', { count: c.classes_today.waitlist_total })} href={`/${locale}/calendar`} />
            )}
            {c?.outstanding_payments && (
              <SummaryCard {...METRIC_ICONS.payments} label={t('card_payments')} value={formatGymAmount(c.outstanding_payments.amount, fmt)}
                sub={t('card_payments_sub', { count: c.outstanding_payments.count, paid: c.outstanding_payments.paid_count })}
                href={taskHref('payments_with_issues', locale)} />
            )}
            {c?.attendance && (
              <>
                <SummaryCard {...METRIC_ICONS.trainers} label={t('card_top_trainers')} value={String(c.attendance.top_trainers)}
                  sub={t('card_top_trainers_sub', { weeks: c.attendance.weeks })} hint={t('card_top_trainers_hint', { weeks: c.attendance.weeks })} />
                <SummaryCard {...METRIC_ICONS.average} label={t('card_avg_classes')}
                  value={formatGymNumber(c.attendance.average_classes_per_member_per_week, fmt)}
                  sub={t('card_avg_classes_sub', { weeks: c.attendance.weeks })} hint={t('card_avg_classes_hint', { weeks: c.attendance.weeks })} />
              </>
            )}
          </div>

          {data.pending_payment_members && (
            <div style={{ marginBottom: 24 }}>
              <Panel title={t('pending_title')} testId="home-pending-payments"
                aside={<strong style={{ fontSize: 22 }} data-testid="home-pending-count">{data.pending_payment_members.count}</strong>}
                footer={data.pending_payment_members.count > data.pending_payment_members.members.length ? (
                  <Link href={taskHref('payments_with_issues', locale)} className="gd-home-link" style={linkStyle}>{t('pending_view_all', { count: data.pending_payment_members.count })}</Link>
                ) : undefined}>
                <p style={{ ...mutedTextStyle, margin: '0 0 8px' }}>{t('pending_sub', { count: data.pending_payment_members.count })}</p>
                {data.pending_payment_members.members.length === 0 ? (
                  <p style={{ ...mutedTextStyle, margin: '12px 0 0' }}>{t('pending_empty')}</p>
                ) : data.pending_payment_members.members.map((m) => (
                  <div key={m.member_id} className="gd-home-row" style={row} data-testid={`home-pending-${m.member_id}`}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link href={memberHref(m.member_id, locale, 'profile')} style={{ color: 'inherit', fontWeight: 600 }}>{m.name}</Link>
                      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{m.plan_name ?? t('members_plan_none')}</div>
                    </div>
                    <strong>{formatGymAmount(m.outstanding_amount, fmt)}</strong>
                    <StatusBadge status={m.payment_status} label={tm(`payment_status_${m.payment_status}`)} />
                  </div>
                ))}
              </Panel>
            </div>
          )}

          <div style={{ ...panelsGrid, marginBottom: 16 }}>
            <Panel title={t('tasks_title')} ariaLabel={t('tasks_title')}
              aside={<span data-testid="home-task-count"><CountBadge count={tasks.length} tone={tasks.length ? 'payments' : 'growth'} /><span style={{ ...mutedTextStyle, marginLeft: 8 }}>{t('tasks_count', { count: tasks.length })}</span></span>}>
              {tasks.length === 0 ? (
                <p style={{ ...mutedTextStyle, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }} data-testid="home-all-clear">
                  <ToneIcon tone="growth" size={32}><CheckIcon size={18} /></ToneIcon>{t('tasks_all_clear')}
                </p>
              ) : tasks.map((task) => (
                <div key={task.key} data-testid={`home-task-${task.key}`}>
                  {task.key === 'welcome_new_members' && canWelcomeHere && task.samples && task.samples.length > 0 ? (
                    <>
                      <div className="gd-home-row" style={row}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <CountBadge count={task.count} tone={TASK_TONE[task.key]} />
                          <div>{t(`task_${task.key}`, { count: task.count, people: 0 })}</div>
                        </div>
                      </div>
                      {task.samples.map((s) => (
                        <div key={s.id} className="gd-home-row" style={{ ...row, borderTop: 0, paddingTop: 4 }} data-testid={`home-welcome-${s.id}`}>
                          <Link href={memberHref(s.id, locale)} style={{ color: 'inherit', fontWeight: 600 }}>{s.name}</Link>
                          <button type="button" style={primaryBtnSmall()} onClick={() => setWelcomeFor(s)}>{t(TASK_ACTION_KEY[task.key])}</button>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="gd-home-row" style={row}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        <CountBadge count={task.count} tone={TASK_TONE[task.key]} />
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
                      </div>
                      <Link href={taskHref(task.key, locale)} className="gd-home-link" style={linkStyle}>{t(TASK_ACTION_KEY[task.key])} →</Link>
                    </div>
                  )}
                </div>
              ))}
            </Panel>

            <Panel title={t('quick_title')} testId="home-quick-actions">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                {quickActions.map((qa) => (
                  <Link key={qa.key} href={quickActionHref(qa.key, locale)} data-testid={`home-quick-${qa.key}`}
                    style={{ ...primaryBtnSmall(), textDecoration: 'none', textAlign: 'center', display: 'block', boxSizing: 'border-box', padding: '10px 12px' }}>
                    {t(`quick_${qa.key}`)}
                  </Link>
                ))}
              </div>
            </Panel>
          </div>

          <div style={panelsGrid}>
            {data.classes && (
              <Panel title={t('classes_title')}
                footer={<Link href={`/${locale}/calendar`} className="gd-home-link" style={linkStyle}>{t('classes_view_all')}</Link>}>
                {data.classes.length === 0 ? (
                  <p style={{ ...mutedTextStyle, margin: 0 }}>{t('classes_empty')}</p>
                ) : data.classes.map((k) => {
                  const full = k.capacity != null && k.booked_count >= k.capacity;
                  return (
                    <div key={k.id} className="gd-home-row" style={row} data-testid={`home-class-${k.id}`}>
                      <div style={{ display: 'flex', gap: 12, minWidth: 0, flex: 1 }}>
                        <strong style={{ minWidth: 54, fontVariantNumeric: 'tabular-nums' }}>{formatGymTime(k.starts_at, fmt)}</strong>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{k.name}</div>
                          <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>
                            {t('class_duration', { minutes: classMinutes(k) })}
                            {k.trainer_name ? ` · ${k.trainer_name}` : ''}{k.space_name ? ` · ${k.space_name}` : ''}
                          </div>
                          <div style={{ fontSize: 12, marginTop: 2 }}>
                            <span style={{ fontWeight: 600, color: full ? 'var(--gd-warning, #d97706)' : 'inherit' }}>
                              {k.booked_count}{k.capacity != null ? `/${k.capacity}` : ''} {t('class_booked')}
                            </span>
                            {k.waitlist_count > 0 && <span style={{ color: 'var(--gd-warning, #d97706)' }}>{` · ${t('class_waitlist', { count: k.waitlist_count })}`}</span>}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {canStartClass(k.status) && (
                          <Link href={startClassHref(k.id, locale)} style={{ ...primaryBtnSmall(), textDecoration: 'none' }}>{t('class_start')}</Link>
                        )}
                        {classMessagingOn && canStartClass(k.status) && (
                          <button type="button" style={secondaryBtnSmall} onClick={() => setMessageClass({ id: k.id, name: k.name })}>{tc('send_communication')}</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )}
            {data.latest_members && (
              <Panel title={t('members_title')}
                footer={<Link href={`/${locale}/members`} className="gd-home-link" style={linkStyle}>{t('members_view_all')}</Link>}>
                {data.latest_members.length === 0 ? (
                  <p style={{ ...mutedTextStyle, margin: 0 }}>{t('members_empty')}</p>
                ) : data.latest_members.map((m) => (
                  <div key={m.id} className="gd-home-row" style={{ ...row, justifyContent: 'flex-start' }}>
                    <Avatar name={m.name} src={m.image_url} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Link href={memberHref(m.id, locale, 'profile')} style={{ color: 'inherit', fontWeight: 600 }}>{m.name}</Link>
                      <div style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{m.plan_name ?? t('members_plan_none')}</div>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--gd-text-muted, #6b7280)', whiteSpace: 'nowrap' }}>{formatGymDate(m.created_at, fmt)}</span>
                  </div>
                ))}
              </Panel>
            )}
          </div>
        </>
      )}
      {messageClass && (
        <ClassCommunicationModal sessionId={messageClass.id} sessionName={messageClass.name} onClose={() => setMessageClass(null)} />
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
            load();
          }}
        />
      )}
    </div>
  );
}
