// #1537 — what a recurring-configuration Draft changes relative to the version
// it would replace, as pure decisions.
//
// The "Review your changes" step shows this and nothing in it prices anything:
// each line carries the frozen unit price of its own version, and the amount
// due is `initialCharge()`'s (the one function Save & Pay charges from).

import type { SimulationAssignment } from './billingSimulation';

export interface RecurringLine {
  key: string;
  productId: number;
  name: string;
  quantity: number;
  unitPrice: number;
  billingFrequency: string | null;
}

export type ConfigurationChange =
  | { kind: 'added'; line: RecurringLine }
  | { kind: 'removed'; line: RecurringLine }
  | { kind: 'quantity_changed'; line: RecurringLine; from: number; to: number }
  | { kind: 'price_changed'; line: RecurringLine; from: number; to: number }
  | { kind: 'plan_changed'; from: string | null; to: string | null }
  | { kind: 'fee_changed'; from: number | null; to: number | null }
  | { kind: 'promotion_added'; name: string }
  | { kind: 'promotion_removed'; name: string };

/**
 * The recurring lines of a version: its Additional Periodic Services still
 * running and the Period benefits of its Membership Plan, keyed by Product so
 * the same Product on both versions is one line (the schema allows one open
 * line per Product and version).
 */
export function recurringLinesOf(a: Pick<SimulationAssignment, 'services' | 'planBenefits'> | null): RecurringLine[] {
  if (!a) return [];
  const lines = new Map<string, RecurringLine>();
  for (const b of a.planBenefits) {
    if (b.category !== 'periodical') continue;
    lines.set(`benefit-${b.productId}`, {
      key: `benefit-${b.productId}`, productId: b.productId, name: b.name, quantity: b.quantity,
      unitPrice: b.unitPrice, billingFrequency: b.billingFrequency,
    });
  }
  for (const s of a.services) {
    if (s.endsOn != null) continue;
    lines.set(`service-${s.productId}`, {
      key: `service-${s.productId}`, productId: s.productId, name: s.name, quantity: s.quantity,
      unitPrice: s.unitPrice, billingFrequency: s.billingFrequency,
    });
  }
  return [...lines.values()];
}

const cents = (n: number | null) => (n == null ? null : Math.round(n * 100));

/**
 * `before` is the Active version (or `null` for a member with no recurring
 * configuration, where everything is an addition).
 */
export function diffConfigurations(
  before: SimulationAssignment | null, after: SimulationAssignment,
): ConfigurationChange[] {
  const out: ConfigurationChange[] = [];
  const was = new Map(recurringLinesOf(before).map((l) => [l.key, l]));
  const now = new Map(recurringLinesOf(after).map((l) => [l.key, l]));

  for (const [key, line] of now) {
    const prev = was.get(key);
    if (!prev) { out.push({ kind: 'added', line }); continue; }
    if (prev.quantity !== line.quantity) out.push({ kind: 'quantity_changed', line, from: prev.quantity, to: line.quantity });
    if (cents(prev.unitPrice) !== cents(line.unitPrice)) out.push({ kind: 'price_changed', line, from: prev.unitPrice, to: line.unitPrice });
  }
  for (const [key, line] of was) if (!now.has(key)) out.push({ kind: 'removed', line });

  if (before) {
    if ((before.planName ?? null) !== (after.planName ?? null)) out.push({ kind: 'plan_changed', from: before.planName ?? null, to: after.planName ?? null });
    if (cents(before.membershipFeePrice) !== cents(after.membershipFeePrice)) out.push({ kind: 'fee_changed', from: before.membershipFeePrice, to: after.membershipFeePrice });
  }

  const standing = (a: SimulationAssignment | null) =>
    new Set((a?.promotions ?? []).filter((p) => p.revokedAt == null).map((p) => p.name ?? ''));
  const pBefore = standing(before);
  const pAfter = standing(after);
  for (const name of pAfter) if (!pBefore.has(name)) out.push({ kind: 'promotion_added', name });
  for (const name of pBefore) if (!pAfter.has(name)) out.push({ kind: 'promotion_removed', name });
  return out;
}
