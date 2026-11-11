'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateOnly } from '@/lib/gymFormat';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle, innerCardStyle } from '@/components/formChrome';
import { ContextMenu } from '@/components/ContextMenu';
import { ExpandedRow, fmtDate, fmtDateTime } from '../payments/billing-events/BillingEventExpandedRow';
import {
  BillingEventHeaderFacts, BillingEventStatusBadge, NormalizedPaymentStatusBadge, billingEventAmountLabel, useBillingEventActions,
  type BillingEventHeaderRow,
} from '../payments/billing-events/BillingEventShared';
import { splitPaymentsTabEvents, type PaymentsTabEvent } from './paymentsTabView';

/** A ledger row as the shared Billing Events renderer reads it (#2571). */
type MemberBillingEvent = PaymentsTabEvent & BillingEventHeaderRow;

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
  const [events, setEvents] = useState<MemberBillingEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pastOpen, setPastOpen] = useState(false);

  const load = useCallback(() => {
    apiFetch<{ items: MemberBillingEvent[] }>(`/payments/billing-events?member_id=${memberId}&limit=200`)
      .then((r) => { setEvents(r.items ?? []); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  const { unresolved, past } = useMemo(() => splitPaymentsTabEvents(events ?? []) as {
    unresolved: MemberBillingEvent[]; past: MemberBillingEvent[];
  }, [events]);

  // Expansion lives here (not per row) so an action can open the event it acted on.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const { menuItems, modal, canWrite, readOnlyTitle } = useBillingEventActions<MemberBillingEvent>({
    onChanged: load,
    openDetails: (id) => setExpanded((p) => new Set(p).add(id)),
  });
  const list = { gym, t, expanded, toggle, menuItems, onChanged: load, canWrite, readOnlyTitle };

  if (failed) return <p style={formErrorStyle}>{t('members.payments_error')}</p>;
  if (events === null) return <p style={cardMutedTextStyle}>{t('members.payments_loading')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {modal}
      <div>
        <div style={cardSectionLabelStyle}>{t('members.payments_unresolved')}</div>
        {unresolved.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_unresolved_empty')}</p>
          : <EventList events={unresolved} {...list} />}
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
          : <EventList events={past} {...list} />)}
      </div>
    </div>
  );
}

interface ListProps {
  gym: ReturnType<typeof useGymFormatSettings>;
  t: ReturnType<typeof useTranslations>;
  expanded: Set<number>;
  toggle: (id: number) => void;
  menuItems: ReturnType<typeof useBillingEventActions<MemberBillingEvent>>['menuItems'];
  onChanged: () => void;
  canWrite: boolean;
  readOnlyTitle?: string;
}

function EventList({ events, ...rest }: ListProps & { events: MemberBillingEvent[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((ev) => <EventRow key={ev.id} ev={ev} {...rest} />)}
    </div>
  );
}

/**
 * #2571: the header carries the same fields and the same actions as a row of
 * Payments → Billing Events (date, created, amount, status, payment status,
 * ⋮ menu), from the shared `BillingEventShared` module.
 */
function EventRow({ ev, gym, t, expanded, toggle, menuItems, onChanged, canWrite, readOnlyTitle }: ListProps & { ev: MemberBillingEvent }) {
  const open = ev.id != null && expanded.has(ev.id);
  const cell: React.CSSProperties = { fontSize: 13, whiteSpace: 'nowrap' };

  return (
    <div style={innerCardStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(ev.id!)}
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', flex: 1, minWidth: 0 }}
        >
          <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
          <span style={{ ...cell, fontWeight: 500 }}>{fmtDate(ev.billing_date, gym)}</span>
          <span style={{ ...cell, flex: 1, minWidth: 120, whiteSpace: 'normal', color: '#6b7280' }}>{ev.plan_name ?? '—'}</span>
          <span style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>{fmtDateTime(ev.created_at, gym)}</span>
          <span style={{ ...cell, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{billingEventAmountLabel(ev)}</span>
          <BillingEventStatusBadge row={ev} t={t} />
          <NormalizedPaymentStatusBadge status={ev.normalized_payment_status} t={t} />
          <BillingEventHeaderFacts row={ev} t={t} />
        </button>
        <ContextMenu items={menuItems(ev)} ariaLabel={t('billing_events_page.col_actions')} />
      </div>
      {open && ev.id != null && (
        <div style={{ marginTop: 8 }}>
          <ExpandedRow key={`${ev.id}-${ev.status}-${ev.refunded_amount ?? ''}`} billingEvent={ev} onChanged={onChanged} canWrite={canWrite} readOnlyTitle={readOnlyTitle} t={t} asCell={false} />
        </div>
      )}
    </div>
  );
}
