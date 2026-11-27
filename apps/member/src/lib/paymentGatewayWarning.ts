/**
 * #3512 — when the Members App shows the payment-gateway registration warning.
 *
 * Pure, no React and no `t()`: whether the warning is *owed* is the API's
 * (`GET /me/payment-gateway-status`, `registration_required`); this module only
 * says when to ask and whether this sign-in has already been shown it.
 *
 * "After login" is keyed on the Clerk **session** id: a new sign-in is a new
 * session, so the status is asked again on every login and the warning
 * disappears by itself once the API stops requiring it. Within one session it
 * is shown once, so dismissing it never brings it back on the next page. The
 * member id is part of the key because a superadmin impersonating several
 * members keeps one Clerk session.
 */

export const PAYMENT_GATEWAY_STATUS_PATH = '/me/payment-gateway-status';

export interface PaymentGatewayStatus {
  default_payment_method: string;
  has_monei_token: boolean;
  registration_required: boolean;
}

export function warningSeenKey(sessionId: string, gymId: string, memberId: number): string {
  return `payment_gateway_warning_seen:${sessionId}:${gymId}:${memberId}`;
}

export function shouldShowGatewayWarning(status: PaymentGatewayStatus | null | undefined): boolean {
  return status?.registration_required === true;
}
