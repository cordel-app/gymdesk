import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Regression test for #675 — "View Audit Log" on every entity's Details view.
//
// #642 added the action to the Member Details modal only. #675 extends it to
// every entity that has a Details view, all through one shared component so no
// entity-specific implementation can diverge. Three things are pinned here:
//
//  1. Every Details view renders <ViewAuditLogButton> with the entity type the
//     audit system actually writes (recordAudit({ entityType }) in the API) and
//     the record's own id — never a display name.
//  2. The shared component owns the permission rule and the URL shape, so a new
//     Details view cannot ship a hand-rolled variant of either.
//  3. The label resolves in every supported locale (next-intl has no fallback —
//     see apps/admin/src/i18n.ts — so a missing key renders as its raw path).

const SRC_DIR = join(__dirname, '..');
const PAGES_DIR = join(SRC_DIR, 'app', '[locale]');
const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

function read(relative: string, root: EntryRoot = 'pages'): string {
  return readFileSync(join(root === 'pages' ? PAGES_DIR : SRC_DIR, relative), 'utf-8');
}

/**
 * Where an entry's path is rooted: at `app/[locale]` for a page or a page-local
 * modal, or at `src` for a Details view shared by more than one page.
 */
type EntryRoot = 'pages' | 'src';

/**
 * Every Details view in the admin app, with the canonical audit entity type it
 * must deep-link by. Keep this list in step with the Details actions in the
 * context menus — a new entity with a Details view belongs here too.
 */
const DETAILS_VIEWS: {
  file: string;
  entityType: string;
  platform?: true;
  root?: EntryRoot;
  /**
   * A Details view shared by a gym page and a platform one takes its scope as a
   * prop, so the literal lives at the call site. The scope wiring of those pages
   * is asserted separately — see 'the shared Nutrition Library Details modal …'.
   */
  scopeFromProp?: true;
}[] = [
  { file: 'members/MemberDetailModal.tsx',                                entityType: 'member' },
  { file: 'plans/PlanDetailModal.tsx',                                    entityType: 'membership_plan' },
  { file: 'promotions/PromotionDetailModal.tsx',                          entityType: 'promotion' },
  // #965: one Details modal for both Exercise screens, scoped by the page that
  // opens it — the gym Exercises list and Cordel's Base Exercises list.
  { file: 'components/exercises/ExerciseDetailModal.tsx',                  entityType: 'exercise', root: 'src', scopeFromProp: true },
  { file: 'financials/assigned-plans/AssignedPlanDetailsModal.tsx',       entityType: 'user_membership' },
  { file: 'financials/taxes/page.tsx',                                    entityType: 'tax_rate' },
  { file: 'financials/products/page.tsx',                           entityType: 'product' },
  { file: 'workout-templates/page.tsx',                                   entityType: 'workout_template' },
  { file: 'training-plans/page.tsx',                                      entityType: 'training_plan' },
  { file: 'training-plan-templates/page.tsx',                             entityType: 'training_plan_template' },
  { file: 'activity-types/page.tsx',                                      entityType: 'activity_type' },
  { file: 'professional-services/page.tsx',                               entityType: 'professional_service' },
  { file: 'centers/page.tsx',                                             entityType: 'center' },
  { file: 'spaces/page.tsx',                                              entityType: 'space' },
  { file: 'staff/page.tsx',                                               entityType: 'staff' },
  { file: 'themes/page.tsx',                                              entityType: 'theme' },
  { file: 'payments/billing-events/page.tsx',                             entityType: 'billing_event' },
  { file: 'nutrition/nutrition-plans/page.tsx',                           entityType: 'member_nutrition_plan' },
  { file: 'nutrition/nutrition-plan-templates/page.tsx',                  entityType: 'nutrition_plan_template' },
  { file: 'system/gyms/page.tsx',                                         entityType: 'gym',                    platform: true },
  { file: 'cordel/payment-providers/page.tsx',                            entityType: 'payment_provider',       platform: true },
  { file: 'system/themes/page.tsx',                                       entityType: 'theme',                  platform: true },
  // #799: both Nutrition Libraries — the gym's and Cordel's Base one — open the
  // same Details modal, which takes its Audit Log scope as a prop.
  { file: 'components/nutritionLibrary/NutritionItemDetailsModal.tsx',     entityType: 'nutrition_library_item', root: 'src', scopeFromProp: true },
];

describe('View Audit Log on every Details view (#675)', () => {
  it.each(DETAILS_VIEWS)('$file offers View Audit Log for entity type "$entityType"', ({ file, entityType, platform, root, scopeFromProp }) => {
    const src = read(file, root);

    expect(src, `${file} must import the shared component`)
      .toContain("from '@/components/ViewAuditLogButton'");

    // A usage can span lines and contain `=>` inside its callbacks, so match
    // lazily up to the self-closing tag rather than "no > until the end".
    const usages = src.match(/<ViewAuditLogButton[\s\S]*?\/>/g) ?? [];
    const usage = usages.find((u) => u.includes(`entityType="${entityType}"`));
    expect(usage, `${file} must render <ViewAuditLogButton entityType="${entityType}" …/>`).toBeDefined();

    // The filter is applied by id (`id`, `memberId`, `details?.id`, …), never by
    // a display name, which is neither unique nor stable.
    expect(usage!, `${file} must pass the record's own id as entityId`).toMatch(/entityId=\{[^}]*[Ii]d\b[^}]*\}/);
    expect(usage!, `${file} must not filter the Audit Log by name`).not.toMatch(/entityId=\{[^}]*[Nn]ame\b/);

    if (scopeFromProp) {
      expect(usage!, `${file} is shared by a gym page and a platform one, so its scope is a prop`)
        .toMatch(/scope=\{\w+\}/);
    } else if (platform) {
      expect(usage!, `${file} administers a platform-level entity and must link to Cordel → Audit Log`)
        .toContain('scope="platform"');
    } else {
      expect(usage!, `${file} is gym-scoped and must not opt into the platform Audit Log`)
        .not.toContain('scope="platform"');
    }
  });

  it('covers every entity that exposes a Details action in a context menu', () => {
    // Sanity check on the list above: it is the whole point of the ticket that
    // no Details view is left out, so a shrinking list should fail loudly.
    expect(DETAILS_VIEWS.length).toBeGreaterThanOrEqual(23);
    expect(new Set(DETAILS_VIEWS.map((v) => v.file)).size).toBe(DETAILS_VIEWS.length);
  });

  it('keeps the permission rule and the URL shape in the shared component only', () => {
    const component = readFileSync(join(SRC_DIR, 'components', 'ViewAuditLogButton.tsx'), 'utf-8');

    // Admin-only, feature-flag aware — the same rule the sidebar applies.
    expect(component).toContain("flags['system.audit']");
    expect(component).toContain("activeGym?.role === 'admin'");
    expect(component).toContain('isSuperadmin');

    // Both Audit Log routes, filtered by entity type + id.
    expect(component).toContain('entity_type');
    expect(component).toContain('entity_id');
    expect(component).toContain('cordel/audit');

    // No other Details view may hand-roll the deep link.
    for (const { file, root } of DETAILS_VIEWS) {
      expect(read(file, root), `${file} must not build the audit deep link itself`).not.toContain('entity_type=');
    }
  });

  it('the shared Exercise Details modal is opened with the right scope by each page (#965)', () => {
    // Same rule as the Nutrition Library's below: the modal is one
    // implementation, and which Audit Log it opens is the page's decision.
    const gym = read('exercises/page.tsx');
    const cordel = read('cordel/exercises/page.tsx');
    expect(gym).toContain('<ExerciseDetailModal exercise={detailFor} onClose=');
    expect(gym).not.toContain('scope="platform"');
    expect(cordel).toContain('scope="platform"');
  });

  it('the shared Nutrition Library Details modal is opened with the right scope by each library', () => {
    // The modal is one implementation; which Audit Log it opens is the pages'
    // decision, and getting it wrong would send a gym admin to a superadmin page.
    const gym = read('nutrition/nutrition-library/page.tsx');
    const cordel = read('cordel/nutrition-library/page.tsx');

    for (const [name, src] of [['gym', gym], ['Cordel', cordel]] as const) {
      expect(src, `the ${name} library must open the shared Details modal`)
        .toContain('<NutritionItemDetailsModal');
    }
    expect(cordel, 'Cordel → Base Nutrition Library administers platform rows')
      .toMatch(/<NutritionItemDetailsModal[^>]*scope="platform"/);
    expect(gym, "a gym's library must not open the platform Audit Log")
      .not.toMatch(/<NutritionItemDetailsModal[^>]*scope="platform"/);
  });

  it.each(LOCALE_CODES)('resolves the "View Audit Log" label in %s.json', (code) => {
    const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
    const label = (messages.common ?? {}).action_view_audit_log;
    expect(typeof label, `${code}.json is missing common.action_view_audit_log`).toBe('string');
    expect(String(label).length).toBeGreaterThan(0);
  });
});
