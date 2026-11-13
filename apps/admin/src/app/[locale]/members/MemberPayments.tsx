'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle } from '@/components/formChrome';
import {
  BillingEventsTable, useBillingEventActions, type BillingEventsTableRow,
} from '../payments/billing-events/BillingEventShared';
import {
  PAYMENTS_TAB_INITIAL_OPEN, initialExpandedEventIds, splitPastEvents, splitPaymentsTabEvents, type PaymentsTabEvent,
} from './paymentsTabView';

/** A ledger row as the shared Billing Events renderer reads it (#2571). */
type MemberBillingEvent = PaymentsTabEvent & BillingEventsTableRow;

/**
 * #2099 — the Member card's **Payments** tab. Read-only: the member's actual
 * billing events (unresolved ones first, the rest under a collapsed *Past
 * billing events*) and, on expanding one, its own payment transactions
 * (`payment_requests.billing_event_id`). No simulation is read or drawn.
 * Both lists are Payments → Billing Events' own table (`BillingEventsTable`),
 * header included (#2449 follow-up). Since #2778 the newest past event sits
 * on its own under *Last billing event* (open by default) and is not repeated
 * under *Past billing events*; every section collapses independently. That
 * last event's row starts expanded, so its Billing Event lines are on screen.
 */
export function MemberPayments({ memberId }: { memberId: number | string }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [events, setEvents] = useState<MemberBillingEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{ unresolved: boolean; last: boolean; past: boolean }>({ ...PAYMENTS_TAB_INITIAL_OPEN });
  const flip = (k: keyof typeof open) => setOpen((o) => ({ ...o, [k]: !o[k] }));

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
  const { last, rest } = useMemo(() => splitPastEvents(past), [past]);

  // Expansion lives here (not per row) so an action can open the event it acted on.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // The last event's row is opened once per member, on the first load: a reload
  // after an action must not reopen a row the administrator closed.
  const seededFor = useRef<number | string | null>(null);
  useEffect(() => {
    if (events === null || seededFor.current === memberId) return;
    seededFor.current = memberId;
    setExpanded(new Set(initialExpandedEventIds(last)));
  }, [events, last, memberId]);
  const toggle = (id: number) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const { menuItems, modal, canWrite, readOnlyTitle } = useBillingEventActions<MemberBillingEvent>({
    onChanged: load,
    openDetails: (id) => setExpanded((p) => new Set(p).add(id)),
  });
  const table = { gym, t, expanded, onToggle: toggle, menuItems, onChanged: load, canWrite, readOnlyTitle, emptyLabel: '' };

  if (failed) return <p style={formErrorStyle}>{t('members.payments_error')}</p>;
  if (events === null) return <p style={cardMutedTextStyle}>{t('members.payments_loading')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {modal}
      <CollapsibleSection open={open.unresolved} onToggle={() => flip('unresolved')} label={t('members.payments_unresolved')}>
        {unresolved.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_unresolved_empty')}</p>
          : <BillingEventsTable rows={unresolved} {...table} />}
      </CollapsibleSection>
      {last && (
        <CollapsibleSection open={open.last} onToggle={() => flip('last')} label={t('members.payments_last')}>
          <BillingEventsTable rows={[last]} {...table} />
        </CollapsibleSection>
      )}
      <CollapsibleSection open={open.past} onToggle={() => flip('past')} label={`${t('members.payments_past')} (${rest.length})`}>
        {rest.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_past_empty')}</p>
          : <BillingEventsTable rows={rest} {...table} />}
      </CollapsibleSection>
    </div>
  );
}

/** One collapsible section of the tab: a chevron and its label, the body when open. */
function CollapsibleSection({ open, onToggle, label, children }: {
  open: boolean; onToggle: () => void; label: string; children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}
      >
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={cardSectionLabelStyle}>{label}</span>
      </button>
      {open && children}
    </div>
  );
}
