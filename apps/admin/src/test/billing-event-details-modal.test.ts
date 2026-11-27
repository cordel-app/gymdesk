import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DETAILS_EMPTY, PRODUCT_DETAILS_FIELDS, billingEventDetailsView,
} from '../app/[locale]/payments/billing-events/billingEventDetailsView';

// #3300: every Billing Event row's ⋮ offers Details, which opens a modal that
// reproduces the Product Details modal (field set, order, read-only rows) and
// carries View Audit Log; the audit link is no longer in the inline expansion.
// No component-test infra for apps/admin, so the structure is pinned by source.

const SRC = join(__dirname, '..');
const BE = join(SRC, 'app', '[locale]', 'payments', 'billing-events');
const PRODUCTS = join(SRC, 'app', '[locale]', 'financials', 'products', 'page.tsx');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => strip(readFileSync(p, 'utf-8'));

const modalSrc = read(join(BE, 'BillingEventDetailsModal.tsx'));
const sharedSrc = read(join(BE, 'BillingEventShared.tsx'));
const expandedSrc = read(join(BE, 'BillingEventExpandedRow.tsx'));
const productsSrc = read(PRODUCTS);

const opts = {
  statusLabel: 'Paid',
  formatAmount: (a: string | null) => Number(a).toFixed(2),
  formatDateTime: (iso: string | null) => `dt(${iso})`,
  systemActor: 'System',
};

const event = {
  name: 'Gym - November', plan_name: 'Gold', event_type: 'recurring_payment',
  amount: '49.90', currency: 'EUR', notes: null,
  created_at: '2026-11-01T10:00:00Z', created_by: 'Ana',
  modified_at: null, modified_by: null,
};

/** The `label_*`/`audit_*` keys a details modal renders, in order. */
function labelOrder(src: string, from: string): string[] {
  const body = src.slice(src.indexOf(from));
  return [...body.matchAll(/label=\{t[p]?\('((?:label|audit)_[a-z_]+)'\)\}/g)].map((m) => m[1]);
}

describe('Billing Event Details modal (#3300)', () => {
  it('maps an event onto the Product Details field set with — for fields that do not apply', () => {
    const v = billingEventDetailsView(event, opts).values;
    expect(v.name).toBe('Gym - November');
    expect(v.type).toBe('recurring_payment');
    expect(v.status).toBe('Paid');
    expect(v.price).toBe('49.90 EUR');
    expect(v.created_at).toBe('dt(2026-11-01T10:00:00Z)');
    expect(v.created_by).toBe('Ana');
    for (const k of ['description', 'units', 'enrollment_status', 'mandatory', 'frequency', 'validity_days', 'tax_rate', 'modified_at', 'modified_by', 'deleted_at', 'deleted_by'] as const) {
      expect(v[k], k).toBe(DETAILS_EMPTY);
    }
    // Exactly the reference's fields, no Billing Event extras.
    expect(Object.keys(v).sort()).toEqual([
      ...PRODUCT_DETAILS_FIELDS.general, ...PRODUCT_DETAILS_FIELDS.generalGrid,
      ...PRODUCT_DETAILS_FIELDS.billing, ...PRODUCT_DETAILS_FIELDS.audit,
    ].sort());
  });

  it('falls back to the plan name, the system actor and — without misleading values', () => {
    const v = billingEventDetailsView({ ...event, name: null, amount: null, created_by: null, notes: '  ' }, opts);
    expect(v.values.name).toBe('Gold');
    expect(v.values.price).toBe(DETAILS_EMPTY);
    expect(v.values.created_by).toBe('System');
    expect(v.notes).toBeNull();
    expect(billingEventDetailsView({ ...event, notes: 'Paid at desk' }, opts).notes).toBe('Paid at desk');
  });

  it('renders the Product Details labels in the same order and the same read-only rows', () => {
    const productOrder = labelOrder(productsSrc, "title={t('details_title')}")
      .slice(0, PRODUCT_DETAILS_FIELDS.general.length + PRODUCT_DETAILS_FIELDS.generalGrid.length
        + PRODUCT_DETAILS_FIELDS.billing.length + PRODUCT_DETAILS_FIELDS.audit.length + 4);
    const modalOrder = labelOrder(modalSrc, '<CrudModal');
    const productCore = productOrder.filter((k) => modalOrder.includes(k));
    expect(modalOrder).toEqual(productCore);
    expect(modalOrder).toHaveLength(17);
    // One shared row component, so the presentation cannot drift.
    expect(productsSrc).toContain("from '@/components/DetailsModalFields'");
    expect(modalSrc).toContain("from '@/components/DetailsModalFields'");
    expect(modalSrc).toContain("useTranslations('products')");
    expect(modalSrc).toContain('hideSave');
    expect(modalSrc).not.toContain("method: 'POST'");
  });

  it('carries View Audit Log for the same event, closing the modal first', () => {
    expect(modalSrc).toContain('<ViewAuditLogButton entityType="billing_event" entityId={billingEventId ?? undefined} onNavigate={onClose} />');
    expect(modalSrc).toContain('`/payments/billing-events/${billingEventId}`');
  });

  it('offers Details last in every real row\'s ⋮ and no View Audit Log there or inline', () => {
    expect(sharedSrc).toContain("items.push({ kind: 'details' as const, label: t('billing_events_page.action_details'), onClick: () => setDetailsId(id) });");
    const menu = sharedSrc.slice(sharedSrc.indexOf('function menuItems('), sharedSrc.indexOf('const extraModals'));
    expect(menu.lastIndexOf('action_details')).toBeGreaterThan(menu.lastIndexOf('action_cancel_event'));
    expect(menu).not.toMatch(/audit/i);
    expect(sharedSrc).toContain('<BillingEventDetailsModal billingEventId={detailsId} onClose={() => setDetailsId(null)} />');
    expect(expandedSrc).not.toContain('ViewAuditLogButton');
    // Existing document actions are untouched.
    expect(menu).toContain("t('billing_events_page.generate_full_invoice')");
    expect(menu).toContain("t('billing_events_page.view_receipt')");
    // #3548: no manual receipt issuance — the menu only reads an issued receipt.
    expect(menu).not.toContain('generate_receipt');
    expect(sharedSrc).not.toMatch(/\/receipt`, [^)]*'POST'/);
  });

  it('has its labels in all three locales', () => {
    for (const loc of ['en', 'es', 'ca']) {
      const d = JSON.parse(readFileSync(join(SRC, '..', 'locales', 'base', `${loc}.json`), 'utf-8'));
      for (const k of ['action_details', 'details_modal_title', 'details_load_error']) {
        expect(d.billing_events_page[k], `${loc}.${k}`).toBeTruthy();
      }
    }
  });
});
