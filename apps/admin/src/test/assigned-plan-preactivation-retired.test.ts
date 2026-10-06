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

// #1108 stage 2 — the Draft's commit moved off this card and onto the Member
// window's Save & Pay (§7), so what this block asserts is that the card stopped
// offering a commit of its own. The source scan above cannot assert this (it is
// about an absence), so it is asserted here, beside it.
describe('#1108 stage 2 — the Assigned Plan card offers no commit of its own', () => {
  it('has no Activate action and no activation request left on it', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    expect(row).not.toContain("t('action_activate')");
    expect(row).not.toMatch(/\/activate/);
    expect(row).not.toMatch(/activateDraft/);
    expect(row).not.toMatch(/runAction\('activate'\)/);
    // And no replacement dialog either: the 409 is Save & Pay's now, so the
    // conflict is confirmed where the commit is initiated.
    expect(row).not.toContain('ReplacePlanDialog');
    expect(row).not.toContain('activePlanConflict');
    // What a Draft still offers here is editing and discarding it.
    expect(row).toContain("t('action_close')");
    expect(row).toMatch(/EDITABLE_STATUSES\s*=\s*\[[^\]]*'draft'/);
  });

  it('does not offer Edit mode for a locked configuration', () => {
    const row = sources['AssignedPlanExpandedRow.tsx'];
    const editable = row.match(/EDITABLE_STATUSES\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(editable).not.toContain('pending_payment');
    // Closing it, on the other hand, is how staff get out of one.
    const closeable = row.match(/CLOSEABLE_STATUSES\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    expect(closeable).toContain('pending_payment');
  });

  it('lets the Assigned Plans filter name both pre-activation statuses', () => {
    expect(sources['page.tsx']).toMatch(/LIFECYCLE_STATUSES[^=]*=\s*\[[^\]]*'draft'/);
  });

  it.each(LOCALE_CODES)('%s labels the Pending Payment status and drops the retired action', (code) => {
    const locale = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
    // next-intl prints a missing key verbatim, so an absent one would render as
    // `status.pending_payment` in the Status column.
    expect(locale.status.pending_payment).toBeTruthy();
    // The card's own Activate is gone, so its label is a dead key.
    expect(locale.assigned_plans_page.action_activate).toBeUndefined();
  });
});
