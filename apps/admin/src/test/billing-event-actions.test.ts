import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #640 — Billing Events context menu, Details, Retry
// Payment and Manual payment.
//
// The two payment actions are hidden (not merely disabled) where they don't
// apply (§1), Details is the same expanded row rather than a second surface,
// and — since #1459 — Pay Cash / Pay Card / Waive confirm in a modal that
// records nothing until Accept (#640's inline card is superseded).
// This repo has no component-test infra for apps/admin (see
// docs/architecture.md's TL;DR), so — like additional-periodic-services.test.ts
// (#631) — this pins the structure by scanning the source and the locale files.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const PAGE = join(SRC, 'app', '[locale]', 'payments', 'billing-events', 'page.tsx');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8') + readFileSync(join(PAGE, '..', 'BillingEventExpandedRow.tsx'), 'utf-8') + readFileSync(join(PAGE, '..', 'BillingEventShared.tsx'), 'utf-8'));

const REQUIRED_KEYS = [
  'col_actions',
  'action_details',
  'action_retry',
  'action_pay_cash',
  'action_pay_card',
  'action_waive',
  'status_waived',
  'action_error',
  'status_pending',
  'details_heading',
  'det_id',
  'det_created_by',
  'det_modified_at',
  'det_modified_by',
  'det_failure_reason',
  'actor_system',
  'cash_modal_title',
  'card_modal_title',
  'waive_modal_title',
  'cash_modal_body',
  'card_modal_body',
  'waive_modal_body',
  'waive_reason',
  'modal_accept',
  'modal_close',
  'manual_success',
  'waive_success',
  'retry_running',
  'retry_success',
  'retry_failed',
  'retry_failed_paused',
  'col_tx_source',
  'col_tx_attempt',
  'col_tx_reason',
  'status_cancelled',
  'header_member',
  'header_method',
  'header_attempts',
  'action_refund',
  'action_cancel_event',
  'cancel_modal_title',
  'cancel_modal_body',
  'refund_modal_title',
  'refund_kind_full',
  'refund_kind_lines',
  'refund_kind_adhoc',
  'refund_method',
  'refund_selected_total',
  'refund_final_amount',
  'refund_success',
  'refund_pending',
  'tx_refund',
] as const;

describe('Billing Events payment actions (#640)', () => {
  it('renders a context menu per row', () => {
    expect(pageSrc).toMatch(/import \{ ContextMenu[^}]*\} from '@\/components\/ContextMenu'/);
    expect(pageSrc).toContain('<ContextMenu items={menuItems(row)}');
  });

  it('offers Details unconditionally and each payment action only on the API flag', () => {
    expect(pageSrc).toContain("label: t('billing_events_page.action_details')");
    for (const flag of ['can_pay_cash', 'can_pay_card', 'can_retry', 'can_waive']) {
      expect(pageSrc).toContain(`if (row.${flag}) {`);
    }
  });

  it('offers Cancel (the event, #2480) and Refund only on the API flags, never as a dismissal (#1459 §2)', () => {
    expect(pageSrc).toContain('if (row.can_cancel) {');
    expect(pageSrc).toContain('if (row.can_refund) {');
    // Cancelling is a backend action behind a confirmation, not a closed modal.
    expect(pageSrc).toContain('`/payments/billing-events/${id}/cancel`');
    expect(pageSrc).toContain('<ConfirmDialog');
    expect(pageSrc).not.toMatch(/cancel_payment/);
  });

  it('shows Member, Payment method and Attempts in the header from the API fields', () => {
    expect(pageSrc).toContain('row.payment_method_name');
    expect(pageSrc).toContain('row.attempt_count');
    expect(pageSrc).toContain("t('billing_events_page.header_attempts')");
  });

  it('records a refund only from the modal\'s Accept', () => {
    const modal = readFileSync(join(PAGE, '..', 'RefundModal.tsx'), 'utf-8');
    expect(modal).toContain('async function accept()');
    expect(modal).toContain('`/payments/billing-events/${billingEventId}/refund`');
    expect(modal.match(/method: 'POST'/g)).toHaveLength(1);
    expect(modal).toContain('refundRequestBody(kind, selected, adhoc)');
  });

  // #2797: the refund goes back through the original payment's method.
  it('shows Refund through as a read-only value and offers no payment method choice', () => {
    const modal = readFileSync(join(PAGE, '..', 'RefundModal.tsx'), 'utf-8');
    expect(modal).not.toContain('<select');
    expect(modal).not.toContain('setMethod');
    expect(modal).toContain('{opts.method.name}');
    expect(modal).toContain('formValueStyle');
  });

  it('confirms cash, card and waive in a modal that sends nothing until Accept', () => {
    expect(pageSrc).toContain('<PaymentActionModal');
    expect(pageSrc).toContain('onClose={closePending}');
    // The request is built only in the Accept handler, from the pure module.
    expect(pageSrc).toContain('async function acceptAction(');
    expect(pageSrc).toContain('actionRequest(kind');
    const modal = readFileSync(join(PAGE, '..', 'PaymentActionModal.tsx'), 'utf-8');
    expect(modal).toContain('onClick={() => onAccept(');
    expect(modal).toContain('disabled={busy}');
    expect(modal).not.toContain('apiFetch');
  });

  it('keeps Details on the same expanded row as the transactions list', () => {
    expect(pageSrc).toContain("t('billing_events_page.details_heading')");
    expect(pageSrc).toContain("t('billing_events_page.transactions_heading')");
    expect(pageSrc).toContain('function openDetails(id: number)');
  });

  it('disables the write actions for a read-only PAYMENTS role', () => {
    // #613: shown but not actionable, with the read-only hint as the tooltip.
    expect(pageSrc).toContain("useModuleAccess('PAYMENTS')");
    expect(pageSrc).toContain('disabled: !canWrite');
    expect(pageSrc).toContain('title: readOnlyTitle');
  });

  it('renders the pending status the derived-status model introduced', () => {
    expect(pageSrc).toContain("'pending'");
    expect(pageSrc).toContain("pending: t('billing_events_page.status_pending')");
  });

  for (const code of LOCALE_CODES) {
    it(`has every new billing_events_page key in ${code}.json`, () => {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const section = messages.billing_events_page;
      expect(section).toBeDefined();
      for (const key of REQUIRED_KEYS) {
        expect(section[key], `${code}.json billing_events_page.${key}`).toBeTruthy();
      }
    });
  }

  it('keeps the retry toasts parameterised by attempt count in every locale', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      expect(messages.billing_events_page.retry_failed).toContain('{attempts}');
      expect(messages.billing_events_page.retry_failed_paused).toContain('{attempts}');
    }
  });
});
