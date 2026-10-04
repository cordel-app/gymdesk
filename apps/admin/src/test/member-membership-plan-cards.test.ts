import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cardExpandCaretStyle, cardExpandToggleStyle } from '../components/formChrome';

// Regression tests for #958 — the Member's MEMBERSHIP PLANS section as one card
// per Assigned Membership Plan.
//
// Four of the ticket's answers are structural rather than cosmetic, and this is
// what pins them:
//
//  * the card carries the seven summary fields, Created by / Created at among
//    them, through the shared `CardDetailRow` (Q4: that metadata is a column of
//    `user_memberships` now, not an `audit_logs` read);
//  * the actions stay in the `⋮` menu (Q2 `menu`), and a historical card offers
//    `Details` alone;
//  * expanding renders the *shared* Assigned Plan card body (Q3 `share`), so
//    there is no second rendering of a frozen configuration to drift from the
//    Assigned Plans page — and it renders it `embedded`, which is what keeps
//    that body's own header, `⋮` and Edit mode out of the Member card;
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
const cardBodySrc = read(join(SRC, 'components', 'assignedPlan', 'AssignedPlanExpandedRow.tsx'));
const detailsDialogSrc = read(join(SRC, 'components', 'assignedPlan', 'AssignedPlanDetailsDialog.tsx'));

function members(code: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
  return (messages.members ?? {}) as Record<string, string>;
}

describe('#958: the card is a summary of the assignment', () => {
  it('renders the seven summary fields, through the shared Label: Value row', () => {
    expect(sectionSrc).toContain("import { CardDetailRow } from '@/components/CardDetailRow'");
    for (const key of [
      'membership_created_by',
      'membership_created_at',
      'membership_start',
      'membership_end',
      'membership_status',
    ]) {
      expect(sectionSrc, `${key} is not on the card`).toContain(`t('${key}')`);
    }
    // Plan name and price are the header, so they are not labelled rows.
    expect(sectionSrc).toContain('plan.plan_name');
    expect(sectionSrc).toContain('plan.membership_fee');
  });

  it('reads the creation actor off the row rather than deriving it', () => {
    expect(sectionSrc).toContain('plan.created_by_name');
    expect(sectionSrc).toContain('plan.created_at');
    // An assignment that snapshotted no actor reads as the em dash, never as a
    // guess or a second request.
    expect(sectionSrc).toContain("plan.created_by_name ?? '—'");
    expect(sectionSrc, 'the card re-reads the audit log').not.toContain('audit-logs');
  });

  it('shows the status as a badge, in the app\'s own styling', () => {
    expect(sectionSrc).toContain('<StatusBadge status={plan.status}');
    // No status colour of this section's own (#958 "Do not introduce new status
    // colours or styling").
    expect(sectionSrc).not.toMatch(/#6c63ff|#4b45c6|#eef0ff/i);
  });
});

describe('#958: the actions stay in the ⋮ menu (Q2)', () => {
  it('offers Assign New Plan, Cancel Plan and Details on a live plan', () => {
    expect(sectionSrc).toContain("t('action_assign_new_plan')");
    expect(sectionSrc).toContain("t('action_cancel_plan')");
    expect(sectionSrc).toContain("label: t('action_details'), onClick: onShowDetails");
    // Cancel is the destructive one, and red comes from the menu's own flag.
    expect(sectionSrc).toMatch(/action_cancel_plan'\), onClick: \(\) => onCancelPlan\(plan\), danger: true/);
  });

  it('gives a historical card Details and nothing else', () => {
    // The lifecycle pair is gated on the same `canWrite` the history card is
    // rendered with as `false`, while `onShowDetails` is passed to both.
    expect(sectionSrc).toContain('const lifecycleItems = canWrite && onAssignNewPlan && onCancelPlan');
    expect(sectionSrc).toMatch(/history\.map\(\(m\) => \([\s\S]{0,400}canWrite=\{false\}/);
    expect(sectionSrc).toMatch(/history\.map\(\(m\) => \([\s\S]{0,400}onShowDetails=/);
  });

  it('renders no action button on the card beside the menu', () => {
    // Everything the ticket drew as `[ Cancel ] [ Assign new plan ] [ Details ]`
    // is a menu item; the only buttons left are the expand toggle, the inline
    // add draft's own Save/Cancel and `+ Add Membership Plan`.
    const buttons = sectionSrc.match(/<button/g) ?? [];
    expect(buttons.length).toBeLessThanOrEqual(4);
  });
});

describe('#958: the expansion is the shared Assigned Plan card body (Q3 share)', () => {
  it('renders that component, embedded, instead of a second rendering', () => {
    expect(sectionSrc).toContain(
      "import { AssignedPlanExpandedRow } from '@/components/assignedPlan/AssignedPlanExpandedRow'",
    );
    expect(sectionSrc).toContain(
      '<AssignedPlanExpandedRow assignedPlanId={plan.id} onChanged={onChanged} embedded />',
    );
    // No section of that body is restated here — the snapshot's sections, their
    // order and their labels are the shared declaration's.
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

  it('uses the app\'s one expand affordance, declared in formChrome', () => {
    expect(sectionSrc).toContain('style={cardExpandToggleStyle}');
    expect(sectionSrc).toContain('style={cardExpandCaretStyle}');
    expect(sectionSrc).toContain('aria-expanded={expanded}');
    expect(cardExpandToggleStyle.border).toBe('none');
    expect(cardExpandToggleStyle.color).toBe('inherit');
    expect(cardExpandCaretStyle.fontSize).toBe(11);
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

describe('#958: the labels resolve in every locale', () => {
  it.each(LOCALE_CODES)('%s carries the new members keys', (code) => {
    const ns = members(code);
    for (const key of ['membership_created_by', 'membership_created_at', 'membership_plan_snapshot']) {
      expect(ns[key], `members.${key} missing from ${code}.json`).toBeTruthy();
    }
  });
});
