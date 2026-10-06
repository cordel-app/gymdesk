import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #786 — the Assigned Plan's **`awaiting_payment`** status and its Submit action
// are retired.
//
// #511 stage 1 added `draft` and `awaiting_payment` plus a Submit action
// (`POST /user-memberships/:id/submit`), but nothing ever created either status,
// so the Submit item and the dates-and-discount Edit form (gated on those two
// statuses) could never be reached. The owner chose to retire them, the API
// dropped the route and migration 198 narrowed the CHECK.
//
// **#1108 stage 1 brought `draft` back** — with the insert paths and the
// `draft -> active` commit that make it reachable, which is exactly what #786
// said was missing — so this file no longer guards that half. It guards the half
// that is still retired: `awaiting_payment`, whose counterpart in #1108 is the
// *Pending Payment* state, and that arrives with stage 2's Save & Pay rather
// than as a value nothing can write for a second time. The `draft` side is
// asserted the other way round, in
// `api/src/test/draft-assignment-status.unit.test.ts`.
//
// `apps/admin` has no component test infrastructure, so this is a source scan,
// the same shape as `spaces-activities-removed.test.ts`.

// #958 moved the card body into `components/assignedPlan/`, shared with the
// Member card; the page that lists the assignments stayed where it was.
const CARD_DIR = join(__dirname, '..', 'components', 'assignedPlan');
const PAGE_DIR = join(__dirname, '..', 'app', '[locale]', 'financials', 'assigned-plans');
const FILES: [string, string][] = [
  ['AssignedPlanExpandedRow.tsx', CARD_DIR],
  ['AssignedPlanConfiguration.tsx', CARD_DIR],
  ['AdditionalPeriodicServices.tsx', CARD_DIR],
  ['page.tsx', PAGE_DIR],
];
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sources = Object.fromEntries(
  FILES.map(([f, dir]) => [f, stripComments(readFileSync(join(dir, f), 'utf-8'))]),
) as Record<string, string>;

describe('#786 — no awaiting_payment status in the admin', () => {
  it.each(FILES.map(([f]) => f))('%s does not name the retired status', (file) => {
    expect(sources[file]).not.toMatch(/'awaiting_payment'/);
  });

  it('offers no Submit action and calls no /submit route', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    expect(row).not.toContain('action_submit');
    expect(row).not.toMatch(/runAction\('submit'\)|\/submit/);
  });

  it('keeps Pause, Reactivate and Close', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    expect(row).toContain("runAction('pause')");
    expect(row).toContain("runAction('reactivate')");
    expect(row).toContain("t('action_close')");
  });

  it.each(LOCALE_CODES)('%s carries no label for the retired status or the Submit action', (code) => {
    const locale = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
    expect(locale.status.awaiting_payment).toBeUndefined();
    expect(locale.assigned_plans_page.action_submit).toBeUndefined();
    // `status.draft` is used by Membership Plans, Themes and templates, and
    // since #1108 stage 1 by an Assigned Plan as well.
    expect(locale.status.draft).toBeDefined();
  });
});

// #1108 stage 1 — the Draft Assigned Plan's own admin half. The source scan
// above cannot assert this (it is about an absence), so the presence is asserted
// here, beside it, rather than in a second file about the same four sources.
describe('#1108 — the admin commits a Draft through Save & Pay (stage 2 over stage 1\'s activation route)', () => {
  it('offers Save & Pay for a Draft, and the two payments for a Pending Payment row, and nothing else out of them', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    expect(row).toContain("detail.status === 'draft'");
    expect(row).toContain("t('action_save_and_pay')");
    expect(row).toContain("detail.status === 'pending_payment'");
    expect(row).toContain("t('action_record_cash_payment')");
    expect(row).toContain("t('action_send_payment_link')");
    // The commit is its own route, so #956's check and the supersede cannot be
    // bypassed by a plain status flip.
    expect(row).toMatch(/\/save-and-pay/);
    expect(row).toMatch(/\/record-payment/);
    expect(row).not.toMatch(/runAction\('activate'\)/);
    expect(row).not.toMatch(/runAction\('save_and_pay'\)/);
  });

  it('raises the shared replacement dialog from the activation\'s own 409', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    expect(row).toContain('ReplacePlanDialog');
    expect(row).toContain('activePlanConflict');
  });

  it('lets the Assigned Plans filter name a Draft', () => {
    expect(sources['page.tsx']).toMatch(/LIFECYCLE_STATUSES[^=]*=\s*\[[^\]]*'draft'/);
  });

  it.each(LOCALE_CODES)('%s labels the Save & Pay, cash payment and payment link actions, and the Pending Payment status', (code) => {
    const locale = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
    // next-intl prints a missing key verbatim, so an absent one would render as
    // `assigned_plans_page.action_save_and_pay` in the context menu.
    for (const key of ['action_save_and_pay', 'action_record_cash_payment', 'action_send_payment_link', 'record_cash_confirm', 'payment_link_message']) {
      expect(locale.assigned_plans_page[key], key).toBeTruthy();
    }
    expect(locale.status.pending_payment).toBeTruthy();
  });
});
