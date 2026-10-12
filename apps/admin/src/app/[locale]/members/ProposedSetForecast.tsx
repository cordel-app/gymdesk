'use client';

// #1521 — **New Billing Event Simulation**: the billing events that would
// result if the Draft ProductSet proposed from `+ Add Product` became the
// member's. It is the Draft's own forecast (`GET /product-sets/:id/billing-event-simulation`,
// the engine the nightly run prices from): computed on read, persisted nowhere,
// creating no Billing Event and no payment. It is deliberately separate from
// the Billing Events Forecast of the *current* version above it, and says it
// is a projection.

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { cardHintStyle } from '@/components/formChrome';
import type { BillingEventSimulationData } from '@/components/BillingEventSimulation';
import { ProductSetForecast } from './MemberProductSet';

export function ProposedSetForecast({ productSetId }: { productSetId: number | null }) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const [state, setState] = useState<{ loading: boolean; error: boolean; forecast: BillingEventSimulationData | null }>(
    { loading: false, error: false, forecast: null },
  );

  useEffect(() => {
    if (productSetId == null) {
      setState({ loading: false, error: false, forecast: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, error: false, forecast: null });
    apiFetch<BillingEventSimulationData>(`/product-sets/${productSetId}/billing-event-simulation`)
      .then((forecast) => { if (!cancelled) setState({ loading: false, error: false, forecast }); })
      .catch(() => { if (!cancelled) setState({ loading: false, error: true, forecast: null }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productSetId]);

  if (productSetId == null) return <p style={cardHintStyle}>{t('new_simulation_hint')}</p>;
  return (
    <div data-new-billing-event-simulation>
      <p style={cardHintStyle}>{t('new_simulation_projected')}</p>
      <ProductSetForecast forecast={state.forecast} loading={state.loading} error={state.error} />
    </div>
  );
}
