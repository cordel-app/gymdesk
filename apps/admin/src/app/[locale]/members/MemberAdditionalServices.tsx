'use client';

// #634 §4 — ADDITIONAL SERVICES, a section of its own.
//
// Independent from Membership Plans, Promotions and Promotion Benefits (§4):
// services can be added and removed at any time without touching any of them.
// They are recurring Sellable Items and use those items' existing billing
// configuration — there is no second product model.
//
// A service is attached to one Assigned Plan (#631, migration 164), which is
// what the billing window belongs to, so when the Member holds several plans
// each one gets its own inline table under the plan's name. That keeps the
// section Member-level (§13 — it is not rendered inside a Membership Plan card)
// while still saying which plan a service is billed with. The inline row CRUD
// itself is #631's `AdditionalPeriodicServices`, reused unchanged: one editor,
// one set of rules, wherever services are managed.

import React, { type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { AdditionalPeriodicServices } from '../financials/assigned-plans/AdditionalPeriodicServices';
import type { MemberPlanRow, MemberServiceRow } from './membershipConfiguration';

interface Props {
  plans: MemberPlanRow[];
  services: MemberServiceRow[];
  canWrite: boolean;
  /** Re-reads the configuration and re-runs the Billing Simulation (§12). */
  onChanged: () => void;
}

export function MemberAdditionalServices({ plans, services, canWrite, onChanged }: Props) {
  const t = useTranslations('members');

  // Only a plan that still bills can carry a service; a cancelled or expired
  // one keeps its history on the Assigned Plan card instead.
  const targets = plans.filter((p) => p.is_live && p.starts_at != null);

  if (targets.length === 0) {
    return <p style={dim}>{t('additional_services_needs_plan')}</p>;
  }

  return (
    <div>
      {targets.map((plan) => (
        <div key={plan.id} style={{ marginBottom: targets.length > 1 ? 14 : 0 }}>
          {/* With a single plan the attribution is unambiguous, so the extra
              heading would only add noise. */}
          {targets.length > 1 && (
            <div style={subLabel}>{plan.plan_name ?? `#${plan.id}`}</div>
          )}
          <AdditionalPeriodicServices
            assignedPlanId={plan.id}
            planStartsAt={plan.starts_at as string}
            planStatus={plan.status}
            services={services.filter((s) => s.user_membership_id === plan.id)}
            canWrite={canWrite}
            onChanged={onChanged}
          />
        </div>
      ))}
    </div>
  );
}

const dim: CSSProperties = { color: '#888', fontSize: 13, margin: 0 };
const subLabel: CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#aaa', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 4,
};
