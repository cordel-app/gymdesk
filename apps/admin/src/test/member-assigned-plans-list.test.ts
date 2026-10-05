import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression tests for #1051 — the Member's assigned plans, rendered with the
// Assigned Plans page's own list.
//
// The section used to draw one metadata card per assignment (#958). #1051
// replaced that presentation with the Financials list, extracted into
// `components/assignedPlan/AssignedPlansTable`, because two renderings of one
// entity is what the ticket set out to remove: *"There should be one source of
// truth for the Assigned Plans UI"*. What this file pins is therefore the
// sharing itself plus the three #958 answers that survive the change:
//
//  * one table component, rendered by both screens, with no second column
//    declaration, status formatter or expand affordance on the Member card;
//  * Active and Past as two instances of it (§4), split on `is_live`;
//  * the actions stay in the `⋮` (#958 Q2 `menu`) — `Assign New Plan`,
//    `Cancel Plan`, `Details` — handed to the table by the Member card, with a
//    historical row offering `Details` alone;
//  * expanding renders the *shared* Assigned Plan card body `embedded`
//    (#958 Q3 `share`), so the Member card still reads rather than writes;
//  * `+ Add Membership Plan` is absent while the Member holds a live plan,
//    because under #956 adding one replaces it.
//
// `apps/admin` has no component-test infrastructure (see docs/architecture.md's
// TL;DR), so this is a source scan in the shape of member-card-chrome.test.ts.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (p: string) => stripComments(readFileSync(p, 'utf-8'));

const sectionSrc = read(join(SRC, 'app', '[locale]', 'members', 'MemberMembershipPlans.tsx'));
const tableSrc = read(join(SRC, 'components', 'assignedPlan', 'AssignedPlansTable.tsx'));
const pageSrc = read(join(SRC, 'app', '[locale]', 'financials', 'assigned-plans', 'page.tsx'));
const cardBodySrc = read(join(SRC, 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx'));
const detailsDialogSrc = read(join(SRC, 'components', 'assignedPlan', 'AssignedPlanDetailsDialog.tsx'));

function members(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.members ?? {}) as Record<string, string>;
}

describe('#1051: one Assigned Plans list, rendered by both screens', () => {
  it('is the shared component on the Member card and on the Financials page', () => {
    for (const [name, src] of [['the Member card', sectionSrc], ['the Assigned Plans page', pageSrc]] as const) {
      expect(src, `${name} does not render the shared table`)
        .toContain("from '@/components/assignedPlan/AssignedPlansTable'");
      expect(src, `${name} does not render the shared table`).toContain('<AssignedPlansTable');
    }
  });

  it('leaves neither screen a column declaration, a DataTable or a date formatter of its own', () => {
    for (const [name, src] of [['the Member card', sectionSrc], ['the Assigned Plans page', pageSrc]] as const) {
      expect(src, `${name} declares its own columns`).not.toContain('Column<');
      expect(src, `${name} renders its own DataTable`).not.toContain('<DataTable');
      expect(src, `${name} formats the dates itself`).not.toContain('toLocaleDateString');
      expect(src, `${name} renders its own status badge`).not.toContain('<StatusBadge');
    }
  });

  it('names the columns in the Financials namespace on both screens', () => {
    // §4: "the exact section naming should follow the terminology already used
    // by the Financials UI" — so the headers are resolved once, in the shared
    // component, and the Member card has no copy of them.
    expect(tableSrc).toContain("useTranslations('assigned_plans_page')");
    for (const key of ['col_plan', 'col_starts_at', 'col_ends_at', 'col_status']) {
      expect(tableSrc, `${key} is not a column of the shared table`).toContain(`t('${key}')`);
    }
    expect(sectionSrc, 'the Member card restates a column header').not.toContain('col_plan');
  });

  it('keeps the Member column for the gym-wide list and the Plan for a member-scoped one', () => {
    // #1011 allows exactly one `mobile: 'name'` per declaration, and which
    // column it is is the whole difference between the two scopes: a list of
    // every member's plans is identified by the Member, a list of one member's
    // by the Plan.
    expect(tableSrc).toMatch(/header: t\('col_member'\),\s*\n\s*mobile: 'name'/);
    expect(tableSrc).toMatch(/header: t\('col_plan'\),\s*\n\s*mobile: 'name'/);
    expect(tableSrc).toContain("scope === 'member' ? memberColumns : gymColumns");
    // The Assigned Plans page keeps the scope it had: the Member names its rows.
    expect(pageSrc, 'the Financials list changed scope').not.toContain('scope=');
    expect(sectionSrc).toContain('scope="member"');
  });
});

describe('#1051: Active and Past are two instances of that list (§4)', () => {
  it('splits on is_live and renders a table for each', () => {
    expect(sectionSrc).toContain('const live = plans.filter((p) => p.is_live)');
    expect(sectionSrc).toContain('const history = plans.filter((p) => !p.is_live)');
    expect((sectionSrc.match(/<AssignedPlansTable/g) ?? []).length).toBe(2);
    expect(sectionSrc).toContain('rows={live}');
    expect(sectionSrc).toContain('rows={history}');
  });

  it('labels the two groups, and keeps Past out of the way when there is none', () => {
    expect(sectionSrc).toContain("t('membership_plans_active')");
    expect(sectionSrc).toContain("t('membership_plans_history')");
    expect(sectionSrc).toContain('{history.length > 0 && (');
  });

  it('#1107: Past plans is a collapsible card, collapsed by default, with a count', () => {
    expect(sectionSrc).toContain('useState(false)');
    expect(sectionSrc).toContain('const [pastOpen, setPastOpen]');
    expect(sectionSrc).toContain('aria-expanded={pastOpen}');
    expect(sectionSrc).toContain('({history.length})');
    expect(sectionSrc).toContain('{pastOpen && (');
  });
});

describe('#958: the actions stay in the ⋮ menu (Q2)', () => {
  it('offers Assign New Plan, Cancel Plan and Details on a live plan', () => {
    expect(sectionSrc).toContain("t('action_assign_new_plan')");
    expect(sectionSrc).toContain("t('action_cancel_plan')");
    expect(sectionSrc).toContain("label: t('action_details'), onClick: () => setDetailsPlanId(plan.id)");
    // Cancel is the destructive one, and red comes from the menu's own flag.
    expect(sectionSrc).toMatch(/action_cancel_plan'\), onClick: \(\) => onCancelPlan\(plan\), danger: true/);
  });

  it('gives a historical row Details and nothing else', () => {
    // One `rowActions` for both tables, gated on the row's own `is_live`, so a
    // terminated assignment cannot be offered a lifecycle action by the table
    // it happens to be listed in.
    expect(sectionSrc).toContain('const lifecycleItems: ContextMenuItem[] = canWrite && plan.is_live');
  });

  it('leaves the menu to the caller rather than the list', () => {
    // The Assigned Plans page keeps the `⋮` it already had — the one inside
    // the expanded body — so the shared table must not declare one of its own.
    expect(tableSrc).toContain('rowActions ? rowActions(row) : []');
    expect(pageSrc, 'the Financials list grew a row menu').not.toContain('rowActions');
  });

  it('renders no action button on a row beside the menu', () => {
    // Everything the ticket drew as `[ Cancel ] [ Assign new plan ] [ Details ]`
    // is a menu item; the only buttons left are the inline add draft's own
    // Save/Cancel and `+ Add Membership Plan`.
    const buttons = sectionSrc.match(/<button/g) ?? [];
    expect(buttons.length).toBeLessThanOrEqual(3);
  });
});

describe('#958: the expansion is the shared Assigned Plan card body (Q3 share)', () => {
  it('renders that component from the one table, embedded where the card is not the plan\'s own', () => {
    expect(tableSrc).toContain(
      "import { AssignedPlanExpandedRow } from '@/components/assignedPlan/AssignedPlanExpandedRow'",
    );
    expect(tableSrc).toContain(
      '<AssignedPlanExpandedRow assignedPlanId={row.id} onChanged={onChanged} embedded={embedded} />',
    );
    // The Member card asks for the read-only body; the Assigned Plans page,
    // where a plan's own card lives, does not.
    expect(sectionSrc).toContain('embedded');
    expect(pageSrc, 'the Financials list lost its Edit mode').not.toContain('embedded');
    // No section of that body is restated by either caller — the snapshot's
    // sections, their order and their labels are the shared declaration's.
    for (const key of [
      'section_fee_simulation',
      'section_billing_forecast',
      'section_promotions',
      'benefits_session',
    ]) {
      expect(sectionSrc, `${key} is restated on the Member card`).not.toContain(key);
    }
  });

  it('keeps the body\'s own header, menu and Edit mode out of an embedded render', () => {
    expect(cardBodySrc).toContain('embedded = false');
    expect(cardBodySrc).toMatch(/\{!embedded && \([\s\S]{0,700}<ContextMenu/);
    expect(cardBodySrc).toContain('const editing = !embedded && isEditing');
  });

  it('declares no expand affordance of the Member card\'s own', () => {
    // The chevron is `DataTable`'s, like every other expandable list in the
    // app — the section's former `▸/▾` toggle is gone with its cards.
    expect(sectionSrc).not.toContain('cardExpandToggleStyle');
    expect(sectionSrc).not.toContain('cardExpandCaretStyle');
    expect(sectionSrc).not.toContain("t('membership_plan_snapshot')");
    // And no colour of its own (#958 "Do not introduce new status colours or
    // styling"), on either side of the move.
    expect(sectionSrc).not.toMatch(/#6c63ff|#4b45c6|#eef0ff/i);
    expect(tableSrc).not.toMatch(/#6c63ff|#4b45c6|#eef0ff/i);
  });
});

describe('#1051: the status reads the same on both screens', () => {
  it('shows the date-aware lifecycle status rather than the stored column', () => {
    expect(tableSrc).toContain('row.lifecycle_status');
    expect(sectionSrc, 'the Member card badges the stored status').not.toContain('<StatusBadge');
  });
});

describe('#958: Details reuses the existing modal', () => {
  it('loads the assignment and hands it to the shared modal', () => {
    expect(detailsDialogSrc).toContain("import { AssignedPlanDetailsModal } from './AssignedPlanDetailsModal'");
    expect(detailsDialogSrc).toContain('<AssignedPlanDetailsModal detail={detail} onClose={onClose} />');
    expect(detailsDialogSrc).toContain('`/user-memberships/${assignedPlanId}`');
  });

  it('declares no field layout of its own', () => {
    for (const key of ['detail_source_plan', 'detail_created_by', 'detail_effective_price']) {
      expect(detailsDialogSrc, `${key} is restated by the loader`).not.toContain(key);
    }
  });
});

describe('#958: no generic add while a plan is held (#956)', () => {
  it('gates + Add Membership Plan on the Member having no live plan', () => {
    expect(sectionSrc).toContain('{canWrite && live.length === 0 && !adding && (');
  });

  it('keeps the replacement confirmation, which the server still raises', () => {
    // A Member covered by a family plan somebody else owns holds one too
    // (#956 Q4), so the 409 is reachable even with the button gated.
    expect(sectionSrc).toContain('<ReplacePlanDialog');
  });
});

describe('#1051: the labels resolve in every locale', () => {
  it.each(LOCALE_CODES)('%s carries the two group headings', (code) => {
    const ns = members(code);
    for (const key of ['membership_plans_active', 'membership_plans_history']) {
      expect(ns[key], `members.${key} missing from ${code}.json`).toBeTruthy();
    }
  });
});
