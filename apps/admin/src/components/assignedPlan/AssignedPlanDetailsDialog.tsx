'use client';

// #958 — `⋮ → Details` on an Assigned Membership Plan card of the Member page.
//
// The modal itself is the existing `AssignedPlanDetailsModal` (#511), unchanged
// and shared: the ticket's §"Reuse existing Details UI" is explicit that no
// second detail view may be built for this entity, and §"Details" is explicit
// that what it shows is the assignment's own record rather than the Membership
// Plan's current configuration. All this wrapper adds is the read the Assigned
// Plans page already has in hand when it opens the same modal — the Member card
// lists its plans through `GET /user-memberships/member/:id/configuration`,
// which is one row per assignment and carries none of the detail — so the
// single-row read happens when Details is opened and not for every card.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { cardMutedTextStyle, cardTextLinkStyle, formErrorStyle } from '@/components/formChrome';
import { AssignedPlanDetailsModal } from './AssignedPlanDetailsModal';
import type { AssignedPlanDetail } from './types';

export function AssignedPlanDetailsDialog({ assignedPlanId, viewAsMemberId, onClose }: {
  assignedPlanId: number;
  viewAsMemberId?: number;
  onClose: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const { apiFetch } = useApiClient();
  const loadedRef = useRef(false);

  const [detail, setDetail] = useState<AssignedPlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setDetail(await apiFetch<AssignedPlanDetail>(
        `/user-memberships/${assignedPlanId}${viewAsMemberId != null ? `?as_member_id=${viewAsMemberId}` : ''}`,
      ));
    } catch {
      setError(t('expanded_error'));
    }
  }

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The loaded state is the shared modal and nothing of this wrapper's own —
  // a second layout for the same Details view is what the ticket forbids.
  if (detail) return <AssignedPlanDetailsModal detail={detail} onClose={onClose} />;

  // Until it arrives the dialog is already on screen, so the click is not
  // swallowed: the same overlay and box the modal wears, carrying one sentence.
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 20px' }}>{t('detail_title')}</h2>
        {error ? (
          <p style={{ ...formErrorStyle, margin: 0 }}>
            {error}{' '}
            <button onClick={load} style={cardTextLinkStyle}>{t('retry')}</button>
          </p>
        ) : (
          <p style={{ ...cardMutedTextStyle, margin: 0 }}>{t('expanded_loading')}</p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
