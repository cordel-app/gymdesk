import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MEMBERS_APP_PAYMENT_METHOD, STANDALONE_CART_PAYMENT_METHODS, chosenPaymentMethod, paymentActions,
} from '../lib/paymentConfirmation';

// #3313 — choosing Members App only enables Pay and Cancel; the Billing Event and the payment are
// created by Pay's own request. No component-test infra exists for apps/admin, so the wiring is
// read from the source and the decisions are asserted on the pure module.

const DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const CART_MODAL = readFileSync(join(DIR, 'StandaloneCartPayModal.tsx'), 'utf8');
const REVIEW_MODAL = readFileSync(join(DIR, 'ReviewChangesModal.tsx'), 'utf8');
const ROW = readFileSync(join(DIR, 'MemberExpandedRow.tsx'), 'utf8');

const METHODS = [
  { code: 'members_app', available: true },
  { code: 'monei', available: false },
  { code: 'cash', available: true },
];

describe('#3313 payment method choice', () => {
  it('no selection leaves Pay disabled and Cancel enabled', () => {
    const chosen = chosenPaymentMethod(METHODS, '');
    expect(chosen).toBeNull();
    expect(paymentActions({ chosen, loading: false, busy: false })).toEqual({ pay: false, cancel: true });
  });

  it('selecting Members App enables Pay and Cancel', () => {
    const chosen = chosenPaymentMethod(METHODS, MEMBERS_APP_PAYMENT_METHOD);
    expect(chosen?.code).toBe('members_app');
    expect(paymentActions({ chosen, loading: false, busy: false })).toEqual({ pay: true, cancel: true });
  });

  it('an unavailable method is never chosen, and nothing is enabled while Pay runs', () => {
    expect(chosenPaymentMethod(METHODS, 'monei')).toBeNull();
    const chosen = chosenPaymentMethod(METHODS, 'cash');
    expect(paymentActions({ chosen, loading: true, busy: false }).pay).toBe(false);
    expect(paymentActions({ chosen, loading: false, busy: true })).toEqual({ pay: false, cancel: false });
  });

  it('the standalone cart offers Members App only', () => {
    expect(STANDALONE_CART_PAYMENT_METHODS.map((m) => m.code)).toEqual(['members_app']);
  });
});

describe('#3313 standalone cart Save & Pay', () => {
  it('Save & Pay opens the payment step instead of starting the checkout', () => {
    expect(ROW).toMatch(/target === 'cart'\) setCartPayOpen\(true\)/);
    expect(ROW).not.toMatch(/product-purchases\/checkout/);
  });

  it('selecting a method calls no endpoint; only Pay posts the checkout', () => {
    const onChange = CART_MODAL.slice(CART_MODAL.indexOf('onChange='), CART_MODAL.indexOf('onChange=') + 60);
    expect(onChange).toMatch(/setMethod\(e\.target\.value\)/);
    const payBody = CART_MODAL.slice(CART_MODAL.indexOf('async function pay()'), CART_MODAL.indexOf('const amount ='));
    expect(payBody).toMatch(/product-purchases\/checkout/);
    expect(CART_MODAL.match(/apiFetch<[^>]*>\(`[^`]*product-purchases\/checkout`/g)?.length).toBe(1);
    // A double click never reaches the server.
    expect(payBody).toMatch(/if \(inFlight\.current/);
  });

  it('Pay re-reads the cart Summary and pays the purchases it lists', () => {
    const payBody = CART_MODAL.slice(CART_MODAL.indexOf('async function pay()'), CART_MODAL.indexOf('const amount ='));
    expect(payBody.indexOf('cart-summary')).toBeGreaterThan(-1);
    expect(payBody.indexOf('cart-summary')).toBeLessThan(payBody.indexOf('product-purchases/checkout'));
    expect(payBody).toMatch(/purchase_ids: fresh\.purchase_ids/);
  });

  it('Cancel only closes the modal', () => {
    expect(CART_MODAL).toMatch(/onCancel=\{\(\) => \{ if \(actions\.cancel\) onClose\(\); \}\}/);
  });
});

describe('#3313 Draft review modal', () => {
  it('Pay is enabled by the shared rule and the second action reads Cancel', () => {
    expect(REVIEW_MODAL).toMatch(/chosenPaymentMethod\(methods, method\)/);
    expect(REVIEW_MODAL).toMatch(/saveDisabled=\{!actions\.pay\}/);
    expect(REVIEW_MODAL).toMatch(/cancelLabel=\{t\('cancel'\)\}/);
  });
});
