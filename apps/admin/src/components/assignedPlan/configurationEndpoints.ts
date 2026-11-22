/**
 * #2966 stage 10 — where the Assigned Plan configuration editor writes, decided once.
 *
 * The same editor (`AssignedPlanConfiguration`) edits two kinds of plan:
 *   - an **assignment** (`/user-memberships/:id/…`), the plan staff assigned and its Draft;
 *   - a **plan added to a member's cart** (`/product-sets/:setId/plans/:planSnapshotId/…`, #2966
 *     stage 9), which has no assignment until Save & Pay and is addressed by its plan snapshot.
 *
 * The request bodies are the same for both (stage 9 reused the set-level writers and their contract);
 * only the paths differ, and an added plan's Billing frequency is not editable (it bills on the
 * owner's schedule for its cadence, stage 9's decision), so its editor offers no cadence fields and
 * sends none. Pure: no React, no request.
 */
export type ConfigurationTarget =
  | { kind: 'assignment'; assignedPlanId: number }
  | { kind: 'cart_plan'; productSetId: number; planSnapshotId: number };

export type BenefitSectionKey = 'oneoff' | 'session' | 'periodical';

export interface ConfigurationEndpoints {
  billingDuration: string;
  feeBenefit: string;
  benefits: (section: BenefitSectionKey, assignmentEndpoint: string) => string;
  /** Whether the Billing frequency (interval and unit) is edited beside the durations. */
  cadenceEditable: boolean;
}

export function configurationEndpoints(target: ConfigurationTarget): ConfigurationEndpoints {
  if (target.kind === 'cart_plan') {
    const base = `/product-sets/${target.productSetId}/plans/${target.planSnapshotId}`;
    return {
      billingDuration: `${base}/billing-duration`,
      feeBenefit: `${base}/fee-benefit`,
      benefits: (section) => `${base}/benefits/${section}`,
      cadenceEditable: false,
    };
  }
  const base = `/user-memberships/${target.assignedPlanId}`;
  return {
    billingDuration: `${base}/billing-duration`,
    feeBenefit: `${base}/fee-benefit`,
    benefits: (_section, assignmentEndpoint) => `${base}/${assignmentEndpoint}`,
    cadenceEditable: true,
  };
}

/** The Billing & Duration body without the cadence, for a target whose cadence is not editable. */
export function withoutCadence<T extends Record<string, unknown>>(payload: T): Omit<T, 'recurring_billing_interval' | 'recurring_billing_unit'> {
  const { recurring_billing_interval: _i, recurring_billing_unit: _u, ...rest } = payload;
  return rest;
}
