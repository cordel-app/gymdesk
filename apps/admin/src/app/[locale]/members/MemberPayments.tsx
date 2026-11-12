'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle } from '@/components/formChrome';
import {
  BillingEventsTable, useBillingEventActions, type BillingEventsTableRow,
} from '../payments/billing-events/BillingEventShared';
import { splitPaymentsTabEvents, type PaymentsTabEvent } from './paymentsTabView';

/** A ledger row as the shared Billing Events renderer reads it (#2571). */
type MemberBillingEvent = PaymentsTabEvent & BillingEventsTableRow;

/**
 * #2099 — the Member card's **Payments** tab. Read-only: the member's actual
 * billing events (unresolved ones first, the rest under a collapsed *Past
 * billing events*) and, on expanding one, its own payment transactions
 * (`payment_requests.billing_event_id`). No simulation is read or drawn.
 * Both lists are Payments → Billing Events' own table (`BillingEventsTable`),
 * header included (#2449 follow-up).
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
  const table = { gym, t, expanded, onToggle: toggle, menuItems, onChanged: load, canWrite, readOnlyTitle, emptyLabel: '' };

  if (failed) return <p style={formErrorStyle}>{t('members.payments_error')}</p>;
  if (events === null) return <p style={cardMutedTextStyle}>{t('members.payments_loading')}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {modal}
      <div>
        <div style={cardSectionLabelStyle}>{t('members.payments_unresolved')}</div>
        {unresolved.length === 0
          ? <p style={cardMutedTextStyle}>{t('members.payments_unresolved_empty')}</p>
          : <BillingEventsTable rows={unresolved} {...table} />}
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
          : <BillingEventsTable rows={past} {...table} />)}
      </div>
    </div>
  );
}
