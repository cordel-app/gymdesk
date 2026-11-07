'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateOnly } from '@/lib/gymFormat';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle, innerCardStyle } from '@/components/formChrome';
import { ExpandedRow } from '../payments/billing-events/BillingEventExpandedRow';
import {
  paymentEventTypeKey, paymentStatusKey, paymentStatusTone, splitPaymentsTabEvents, type PaymentsTabEvent,
} from './paymentsTabView';

const TONE_COLOR: Record<string, string> = {
  danger: 'var(--gd-status-danger, #b91c1c)',
  info: 'var(--gd-status-info, #1d4ed8)',
  warning: 'var(--gd-status-warning, #b45309)',
  success: 'var(--gd-status-success, #15803d)',
  neutral: 'var(--gd-text-muted, #666)',
};

/**
 * #2099 — the Member card's **Payments** tab. Read-only: the member's actual
 * billing events (unresolved ones first, the rest under a collapsed *Past
 * billing events*) and, on expanding one, its own payment transactions
 * (`payment_requests.billing_event_id`). No simulation is read or drawn.
 */
export function MemberPayments({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [events, setEvents] = useState<PaymentsTabEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);

  const load = useCallback(() => {
    apiFetch<{ items: PaymentsTabEvent[] }>(`/payments/billing-events?member_id=${memberId}&limit=200`)
      .then((r) => { setEvents(r.items ?? []); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  const { unresolved, past } = useMemo(() => splitPaymentsTabEvents(events ?? []), [events]);

  if (failed) return <p style={formErrorStyle}>{t('members.payments_error')}</p>;
  if (events === null) return <p style={cardMutedTextStyle}>{t('members.payments_loading')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={cardSectionLabelStyle}>{t('members.payments_unresolved')}</div>
        {unresolved.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_unresolved_empty')}</p>
          : <EventList events={unresolved} gym={gym} t={t} />}
      </div>
      <div>
        <button
          type="button"
          aria-expanded={pastOpen}
          onClick={() => setPastOpen((o) => !o)}
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}
        >
          <span style={{ display: 'inline-block', transform: pastOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
          <span style={cardSectionLabelStyle}>{t('members.payments_past')} ({past.length})</span>
        </button>
        {pastOpen && (past.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_past_empty')}</p>
          : <EventList events={past} gym={gym} t={t} />)}
      </div>
    </div>
  );
}

function EventList({ events, gym, t }: {
  events: PaymentsTabEvent[];
  gym: ReturnType<typeof useGymFormatSettings>;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((ev) => <EventRow key={ev.id} ev={ev} gym={gym} t={t} />)}
    </div>
  );
}

function EventRow({ ev, gym, t }: {
  ev: PaymentsTabEvent;
  gym: ReturnType<typeof useGymFormatSettings>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [open, setOpen] = useState(false);
  const eventKey = paymentEventTypeKey(ev.event_type);
  const statusKey = paymentStatusKey(ev.status);
  const tone = TONE_COLOR[paymentStatusTone(ev.status)];

  return (
    <div style={innerCardStyle}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', width: '100%' }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatGymDateOnly(ev.billing_date, gym)}</span>
        <span style={{ fontSize: 13, flex: 1, minWidth: 120 }}>
          {eventKey ? t(`members.${eventKey}` as any) : ev.event_type}
          {ev.plan_name ? ` · ${ev.plan_name}` : ''}
        </span>
        {ev.amount != null && <span style={{ fontSize: 13, fontWeight: 600 }}>{formatGymAmount(parseFloat(ev.amount), gym)}</span>}
        <span style={{ fontSize: 12, fontWeight: 700, color: tone }}>{statusKey ? t(`members.${statusKey}` as any) : ev.status}</span>
      </button>
      {/* #2449: the same renderer Payments → Billing Events expands into. */}
      {open && ev.id != null && (
        <div style={{ marginTop: 8 }}>
          <ExpandedRow billingEvent={ev} onChanged={() => {}} canWrite={false} t={t} asCell={false} />
        </div>
      )}
    </div>
  );
}
