'use client';

// #2966 stage 10 — the editor of a plan staff added to a member's cart. Such a plan has no
// assignment until Save & Pay, so it is read by its plan snapshot (`GET /product-sets/:setId/plans/
// :planSnapshotId`, which also says whether the writers would take an edit) and drawn by the one
// Assigned Plan configuration editor, pointed at the cart-plan routes (`configurationEndpoints()`).
// Every section opens behind its own Edit, exactly as on an Assigned Plan card in Edit mode; a plan
// the routes would refuse (the cart was committed, or the plan belongs to a running version) is
// shown read-only. Presentation and requests only: what may be edited is the server's answer.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { AssignedPlanConfiguration } from '@/components/assignedPlan/AssignedPlanConfiguration';
import type { AssignedPlanSnapshot } from '@/components/assignedPlan/types';
import { cardHintStyle, formErrorStyle } from '@/components/formChrome';

interface CartPlanDetail {
  product_set_id: number;
  plan_snapshot_id: number;
  editable: boolean;
  snapshot: AssignedPlanSnapshot;
}

export function AddedCartPlanEditor({ productSetId, planSnapshotId, canWrite, readOnlyTitle, onChanged }: {
  productSetId: number;
  planSnapshotId: number;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-reads the Member card (the cart's forecast and amounts move with the plan). */
  onChanged: () => void;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [detail, setDetail] = useState<CartPlanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await apiFetch<CartPlanDetail>(`/product-sets/${productSetId}/plans/${planSnapshotId}`));
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? t('added_plan_load_error'));
    }
  }, [apiFetch, productSetId, planSnapshotId, t]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div style={formErrorStyle}>{error}</div>;
  if (!detail) return <div style={cardHintStyle}>{t('loading')}</div>;
  return (
    <div data-added-plan-editor={planSnapshotId}>
      {!detail.editable && <div style={{ ...cardHintStyle, marginBottom: 8 }}>{t('added_plan_not_editable')}</div>}
      <AssignedPlanConfiguration
        assignedPlanId={0}
        cartPlan={{ productSetId, planSnapshotId }}
        planStatus={detail.editable ? 'in_cart' : 'cancelled'}
        snapshot={detail.snapshot}
        cardEditing={detail.editable}
        canWrite={canWrite}
        readOnlyTitle={readOnlyTitle}
        onChanged={() => { void load(); onChanged(); }}
      />
    </div>
  );
}
