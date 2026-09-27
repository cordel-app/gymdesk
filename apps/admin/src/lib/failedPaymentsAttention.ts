'use client';

import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';

/**
 * #779: failed payments awaiting a staff decision.
 *
 * The API owns the definition (`GET /payments/billing-events/attention`, the
 * Billing Events whose derived status is `failed`); this file only polls it and
 * names the one place the badge and the dashboard card send the staff to.
 */

export interface FailedPaymentsAttention {
  count: number;
  oldest_created_at: string | null;
}

/**
 * The work queue: Billing Events filtered by `failed`, oldest first. The list
 * *is* the queue, so there is no page of its own.
 */
export function failedPaymentsQueueHref(locale: string): string {
  return `/${locale}/payments/billing-events?status=failed&order=asc`;
}

/**
 * The sidebar is mounted on every page and the number changes about once a
 * night (the billing run), so a slow poll is plenty.
 */
const POLL_MS = 60_000;

/**
 * Polls the count while `enabled`. A failed read (feature off, no access,
 * network) shows nothing rather than an error: the badge is a hint, and the
 * Billing Events page stays the source of truth.
 */
export function useFailedPaymentsAttention(enabled: boolean): FailedPaymentsAttention | null {
  const { apiFetch } = useApiClient();
  const { activeGymId } = useGym();
  const [value, setValue] = useState<FailedPaymentsAttention | null>(null);

  useEffect(() => {
    if (!enabled || !activeGymId) { setValue(null); return; }
    let cancelled = false;
    const read = async () => {
      try {
        const data = await apiFetch<FailedPaymentsAttention>('/payments/billing-events/attention');
        if (!cancelled) setValue(data);
      } catch {
        if (!cancelled) setValue(null);
      }
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, activeGymId, apiFetch]);

  return value;
}
