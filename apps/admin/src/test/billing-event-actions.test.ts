import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #640 — Billing Events context menu, Details, Retry
// Payment and Manual payment.
//
// The two payment actions are hidden (not merely disabled) where they don't
// apply (§1), Details is the same expanded row rather than a second surface,
// and Manual payment is an inline card — the issue thread's Q2 answer is
// explicit: "it should not be modal. It should be inline inside a card".
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

const pageSrc = stripComments(readFileSync(PAGE, 'utf-8'));

const REQUIRED_KEYS = [
  'col_actions',
  'action_details',
  'action_retry',
  'action_manual_payment',
  'action_error',
  'status_pending',
  'details_heading',
  'det_id',
  'det_created_by',
  'det_modified_at',
  'det_modified_by',
  'det_next_payment',
  'det_failure_reason',
  'actor_system',
  'manual_heading',
  'manual_hint',
  'manual_amount',
  'manual_notes',
  'manual_confirm',
  'manual_cancel',
  'manual_success',
  'retry_running',
  'retry_success',
  'retry_failed',
  'retry_failed_paused',
  'col_tx_source',
  'col_tx_attempt',
  'col_tx_reason',
] as const;

describe('Billing Events payment actions (#640)', () => {
  it('renders a context menu per row', () => {
    expect(pageSrc).toMatch(/import \{ ContextMenu[^}]*\} from '@\/components\/ContextMenu'/);
    expect(pageSrc).toContain('<ContextMenu items={menuItems(row)}');
  });

  it('offers Details unconditionally and the payment actions only when applicable', () => {
    // §1: "Do not show payment actions for events where they are not applicable."
    expect(pageSrc).toContain("label: t('billing_events_page.action_details')");
    expect(pageSrc).toContain('if (row.payment_actions_available) {');
    const guardIdx = pageSrc.indexOf('if (row.payment_actions_available)');
    const retryIdx = pageSrc.indexOf("t('billing_events_page.action_retry')");
    const manualIdx = pageSrc.indexOf("t('billing_events_page.action_manual_payment')");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(retryIdx).toBeGreaterThan(guardIdx);
    expect(manualIdx).toBeGreaterThan(guardIdx);
  });

  it('records the manual payment through an inline card, never a modal', () => {
    expect(pageSrc).not.toContain('CrudModal');
    expect(pageSrc).toContain('manual-payment');
    // The card lives inside the expanded row component, not at page level.
    const expandedIdx = pageSrc.indexOf('function ExpandedRow(');
    const cardIdx = pageSrc.indexOf("t('billing_events_page.manual_heading')");
    const pageIdx = pageSrc.indexOf('export default function BillingEventsPage(');
    expect(cardIdx).toBeGreaterThan(expandedIdx);
    expect(cardIdx).toBeLessThan(pageIdx);
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
