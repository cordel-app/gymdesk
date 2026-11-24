/**
 * #3313 — the payment-method step of an Admin checkout, decided once for both confirmation modals
 * (a Draft's Review modal and the standalone cart's payment modal).
 *
 * Choosing a method is page state and nothing else: it starts no payment and writes no Billing
 * Event. It only decides whether **Pay** may be clicked. The Billing Event and its payment request
 * are created by the one request Pay sends, re-validated against the server's current review at
 * that moment; **Cancel** sends nothing. Pure — no React, no request.
 */

export const MEMBERS_APP_PAYMENT_METHOD = 'members_app';

export interface PaymentMethodOption {
  code: string;
  available: boolean;
}

/** The option a selection names, only while it can be used; `null` for none or an unavailable one. */
export function chosenPaymentMethod<T extends PaymentMethodOption>(methods: readonly T[], code: string): T | null {
  return methods.find((m) => m.code === code && m.available) ?? null;
}

/**
 * Which of the modal's two actions are enabled. Pay needs a usable method and nothing in flight;
 * Cancel is always offered except while Pay's request is running (it would not undo it).
 */
export function paymentActions(input: { chosen: PaymentMethodOption | null; loading: boolean; busy: boolean }): {
  pay: boolean;
  cancel: boolean;
} {
  return {
    pay: input.chosen != null && !input.loading && !input.busy,
    cancel: !input.busy,
  };
}

/**
 * The standalone cart is paid only through the Members App hosted checkout
 * (`POST /members/:id/product-purchases/checkout`), so that is the one method it offers.
 */
export const STANDALONE_CART_PAYMENT_METHODS: readonly PaymentMethodOption[] = [
  { code: MEMBERS_APP_PAYMENT_METHOD, available: true },
];
