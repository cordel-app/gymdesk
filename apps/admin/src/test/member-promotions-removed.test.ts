import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// #931 — Promotions are removed from Members.
//
// "A Promotion applies to a target entity, specifically: Membership Plan, or
// Product. A Member can therefore benefit from a Promotion indirectly
// through the Membership Plan or Product they purchase, but the Promotion
// itself should not be configured or assigned directly to a Member."
//
// So the Member card carries no PROMOTIONS section, no "No promotions applied"
// message and no "+ Add Promotion" button, and the Member-level configuration
// read reports no promotions. Nothing about the Promotion itself changes: it is
// still configured on the Promotions page (Suitable Membership Plans, Product
// Item grants), still applied with the Membership Plan the Member is assigned,
// and the applications an Assigned Plan was agreed with are still displayed on
// the Assigned Plans card from each application's own snapshot (#635 §16).
//
// `apps/admin` has no component-test infrastructure, so this is a source scan,
// the same shape as `included-services-removed.test.ts` and
// `plans-charge-benefits-removed.test.ts`.

const LOCALES_DIR = join(__dirname, '..', '..', 'locales', 'base');
const MEMBERS_DIR = join(__dirname, '..', 'app', '[locale]', 'members');
const ASSIGNED_PLANS_DIR = join(__dirname, '..', 'components', 'assignedPlan');
const PROMOTIONS_DIR = join(__dirname, '..', 'app', '[locale]', 'promotions');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

/** The sources name the removed section in comments, so every scan strips them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourcesIn(dir: string): { file: string; src: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    .map((file) => ({ file, src: stripComments(readFileSync(join(dir, file), 'utf-8')) }));
}

const memberSources = sourcesIn(MEMBERS_DIR);

/** The keys only the Member-level PROMOTIONS section ever used. */
const REMOVED_MEMBER_KEYS = [
  'section_promotions',
  'promotions_none',
  'promotions_add',
  'promotions_add_title',
  'promotions_submit',
  'promotions_remove',
  'promotions_history',
  'promotions_on_plan',
  'promotions_label_plan',
  'promotions_label_promotion',
  'promotions_pick_plan',
  'promotions_pick_plan_first',
  'promotions_already_applied',
  'promotions_blocked_new_members_only',
  'promotions_error_no_plan',
  'promotions_error_no_promotion',
  'promotions_needs_plan',
];

describe('Members: Promotions removed (#931)', () => {
  it('found the Member card sources to check', () => {
    expect(memberSources.map((s) => s.file)).toContain('MemberExpandedRow.tsx');
  });

  it('deletes the Member-level Promotions section component', () => {
    expect(existsSync(join(MEMBERS_DIR, 'MemberPromotions.tsx'))).toBe(false);
    for (const { file, src } of memberSources) {
      expect(src, `${file} still renders MemberPromotions`).not.toContain('MemberPromotions');
    }
  });

  it('renders no PROMOTIONS section, empty message or "+ Add Promotion" in the Member card', () => {
    for (const { file, src } of memberSources) {
      for (const key of REMOVED_MEMBER_KEYS) {
        expect(src, `${file} still references the removed key "${key}"`).not.toContain(`'${key}'`);
        expect(src, `${file} still references the removed key "members.${key}"`).not.toContain(`members.${key}`);
      }
    }
  });

  it('assigns no Promotion from the Member card', () => {
    // The apply/revoke routes are addressed to an Assigned Plan, and no Member
    // surface calls them any more. "+ Add Membership Plan" and the Member's own
    // sections write plans and services only.
    for (const { file, src } of memberSources) {
      if (file === 'AssignPlanInlineEditor.tsx') continue; // see the test below
      expect(src, `${file} still posts to the promotions apply route`).not.toMatch(/\/promotions['`]/);
    }
  });

  it('keeps the Promotions a Membership Plan is assigned with (the indirect path)', () => {
    // #628: assigning a plan may apply the Promotions that target it — that is
    // how a Member benefits from one, and it is a property of the plan being
    // assigned rather than of the Member.
    const assignEditor = memberSources.find((s) => s.file === 'AssignPlanInlineEditor.tsx')!.src;
    expect(assignEditor).toContain('promotion_ids');
    expect(assignEditor).toContain('membership_plan_id=${planId}');
  });

  it('keeps the Member-level read free of promotions', () => {
    const config = memberSources.find((s) => s.file === 'membershipConfiguration.ts')!.src;
    expect(config).not.toContain('MemberPromotionRow');
    expect(config).not.toMatch(/promotions:/);
  });

  it('still displays an Assigned Plan\'s own applied Promotions', () => {
    const card = sourcesIn(ASSIGNED_PLANS_DIR);
    expect(card.map((s) => s.file)).toContain('AssignedPlanPromotions.tsx');
    const expandedRow = card.find((s) => s.file === 'AssignedPlanExpandedRow.tsx')!.src;
    expect(expandedRow).toContain('<AssignedPlanPromotions');
  });

  it('still configures Promotions on their own page', () => {
    const promotions = sourcesIn(PROMOTIONS_DIR).map((s) => s.src).join('\n');
    // Suitable Membership Plans and the Product grants — the two targets.
    expect(promotions).toContain('membership-plans');
    expect(promotions).toContain('applies_to');
  });

  it('drops the removed keys from the "members" namespace in every locale', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      const members = (messages.members ?? {}) as Record<string, unknown>;
      const leftover = REMOVED_MEMBER_KEYS.filter((k) => k in members);
      expect(leftover, `${code}.json still has removed "members" promotion keys`).toEqual([]);
      // The Assign New Plan editor's own Promotions keys stay — that section is
      // the plan's, not the Member's.
      expect(members.assign_new_plan_section_promotions, `${code}.json dropped the assign-plan keys`).toBeTruthy();
    }
  });
});
