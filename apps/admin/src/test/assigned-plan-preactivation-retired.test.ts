import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #786 — the Assigned Plan's pre-activation statuses are retired.
//
// #511 stage 1 added `draft` and `awaiting_payment` plus a Submit action
// (`POST /user-memberships/:id/submit`), but nothing ever created either status,
// so the Submit item and the dates-and-discount Edit form (gated on those two
// statuses) could never be reached. The owner chose to retire them: an
// assignment is `active` from creation. The API dropped the route and migration
// 198 narrowed the CHECK; this guards the admin side from bringing either back.
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

describe('#786 — no pre-activation Assigned Plan status in the admin', () => {
  it.each(FILES.map(([f]) => f))('%s names neither retired status', (file) => {
    expect(sources[file]).not.toMatch(/'draft'|'awaiting_payment'/);
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
    // `status.draft` stays: Membership Plans, Themes and templates still use it.
    expect(locale.status.draft).toBeDefined();
  });
});
