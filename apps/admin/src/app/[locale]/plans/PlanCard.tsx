'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { cardSurfaceStyle } from '@/components/ui';
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu';

const MAX_BENEFITS = 4;

export interface PlanCardData {
  id: number;
  name: string;
  lifecycle_status: string;
  statusLabel: string;
  /** Enrollment status chip (#1513), shown left of the lifecycle status. */
  enrollment_status: string;
  enrollmentStatusLabel: string;
  member_count?: number | null;
  /** Already formatted by the page (server amounts, no arithmetic here). */
  priceText: string;
  /** VAT note under the price; null when the plan has no price. */
  taxNote: string | null;
  periodText: string | null;
  benefits: { key: string; label: string }[];
}

/** One Membership Plan in the card grid (#1369). Presentation only. */
export function PlanCard({ plan, menuItems, active }: {
  plan: PlanCardData;
  menuItems: ContextMenuItem[];
  active: boolean;
}) {
  const t = useTranslations('plans');
  const shown = plan.benefits.slice(0, MAX_BENEFITS);
  const extra = plan.benefits.length - shown.length;
  return (
    <div style={{ ...cardSurfaceStyle, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, outline: active ? '2px solid var(--brand, #6c63ff)' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 16, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={plan.name}>{plan.name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <StatusBadge status={plan.enrollment_status === 'public' ? 'active' : plan.enrollment_status === 'staff_only' ? 'paused' : 'inactive'} label={plan.enrollmentStatusLabel} />
          <StatusBadge status={plan.lifecycle_status} label={plan.statusLabel} />
          <ContextMenu items={menuItems} ariaLabel={`Actions for ${plan.name}`} />
        </div>
      </div>
      <div>
        <span style={{ fontSize: 26, fontWeight: 700 }}>{plan.priceText}</span>
        {plan.periodText && <span style={{ fontSize: 13, color: '#888', marginLeft: 6 }}>/ {plan.periodText}</span>}
        {plan.taxNote && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{plan.taxNote}</div>}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, flex: 1 }}>
        {shown.length === 0
          ? <li style={{ color: '#888', listStyle: 'none', marginLeft: -18 }}>{t('card_no_benefits')}</li>
          : shown.map((b) => <li key={b.key}>{b.label}</li>)}
        {extra > 0 && <li style={{ color: '#888', listStyle: 'none', marginLeft: -18 }}>{t('card_more_benefits', { n: extra })}</li>}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderTop: '1px solid var(--gd-card-border, #eee)', paddingTop: 10 }}>
        <span style={{ fontSize: 13, color: '#888' }}>{t('members_count', { n: plan.member_count ?? 0 })}</span>
      </div>
    </div>
  );
}
