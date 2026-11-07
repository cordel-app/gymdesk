'use client';

// #2470 — the small explanatory text under a Billing & Duration summary. One
// component for the Plans page and the Assigned Plan card (which the Members
// card renders too); which sentences exist is `billingDurationExplanations()`'s
// decision and the words are the `billing_duration_help` namespace's.

import React from 'react';
import { useTranslations } from 'next-intl';

import {
  BILLING_DURATION_HELP_NAMESPACE,
  BillingDurationConfig,
  billingDurationExplanations,
} from '@/lib/billingDurationExplanations';

export function BillingDurationExplanations({ config }: { config: BillingDurationConfig }) {
  const t = useTranslations(BILLING_DURATION_HELP_NAMESPACE);
  const rows = billingDurationExplanations(config);
  if (rows.length === 0) return null;
  return (
    <ul style={listStyle}>
      {rows.map((row) => (
        <li key={row.key} style={itemStyle}>
          <strong>{t(row.labelKey as any)}:</strong> {t(row.textKey as any, row.values as any)}
        </li>
      ))}
    </ul>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4,
};
const itemStyle: React.CSSProperties = { fontSize: 11.5, lineHeight: 1.45, color: '#888' };
