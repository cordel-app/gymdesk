/**
 * #1664 — which payment flows Save & Pay supports and what each needs.
 *
 * The catalogue (`base_payment_methods`, #1663) says which methods are *active*;
 * this module says which of them Gymdesk can actually *process* and what a
 * member must have for it. A catalogue code with no flow here (Google Pay, Apple
 * Pay, PayPal, Bizum) is shown according to its availability and never triggers
 * a flow. Pure.
 */
import type { ManualPaymentMethod } from './paymentAttemptMethod';

export type PayFlow = 'members_app' | 'manual' | 'monei';

const FLOWS: Record<string, { flow: PayFlow; attemptMethod?: ManualPaymentMethod }> = {
  members_app: { flow: 'members_app' },
  cash: { flow: 'manual', attemptMethod: 'cash' },
  card: { flow: 'manual', attemptMethod: 'card_terminal' },
  monei: { flow: 'monei' },
};

export function payFlowFor(code: unknown): { flow: PayFlow; attemptMethod?: ManualPaymentMethod } | null {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(FLOWS, code) ? FLOWS[code] : null;
}

export type UnavailableReason = 'unsupported' | 'monei_token_missing';

export function methodAvailability(code: string, ctx: { hasMoneiToken: boolean }): { available: boolean; reason: UnavailableReason | null } {
  const f = payFlowFor(code);
  if (!f) return { available: false, reason: 'unsupported' };
  if (f.flow === 'monei' && !ctx.hasMoneiToken) return { available: false, reason: 'monei_token_missing' };
  return { available: true, reason: null };
}
