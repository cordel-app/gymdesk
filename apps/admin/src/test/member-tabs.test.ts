import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_MEMBER_TAB,
  MEMBER_TABS,
  MEMBER_TAB_IDS,
  isMemberTabId,
  memberTabFromParam,
  sectionsForTab,
  type MemberSectionKey,
} from '@/app/[locale]/members/memberTabs';

// #961 — the Member card as five parallel tabs.
//
// apps/admin has no component-test infra (docs/architecture.md's TL;DR), so the
// pure declaration is exercised directly and the wiring is pinned by scanning
// the sources and the locale files, the way member-profile-layout.test.ts
// (#882) and add-product-edit-mode.test.ts (#957) do.
//
// What it asserts is what the ticket decided, not how the files are written:
//   - which tabs exist and which sections each one holds is the declaration's,
//     never the JSX's (the rule PLAN_SECTION_ORDER already states for the
//     Membership Plan card, #816);
//   - every section the card renders belongs to exactly one tab, so none can be
//     shown twice or lost in the move;
//   - only the selected tab's sections render — the whole point of the ticket
//     is the card's vertical length;
//   - the strip is the app's one tab component and declares no colour of its
//     own (#912/#954: no lilac literal, no custom active-tab colour);
//   - the inline Edit form stays the Profile's and `⋮ → Edit` opens that tab.

const SRC = join(__dirname, '..');
const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;
const MEMBERS_DIR = join(SRC, 'app', '[locale]', 'members');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const read = (...parts: string[]) => stripComments(readFileSync(join(...parts), 'utf-8'));

const rowSrc = read(MEMBERS_DIR, 'MemberExpandedRow.tsx');
const pageSrc = read(MEMBERS_DIR, 'page.tsx');
const tabsSrc = read(SRC, 'components', 'Tabs.tsx');

function messages(code: string): Record<string, any> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
}

/** The JSX of one tab's pane, from its guard to the next tab's (or the end). */
function pane(tabId: string): string {
  const start = rowSrc.indexOf(`{tab === '${tabId}' && (`);
  expect(start, `no pane for ${tabId}`).toBeGreaterThan(-1);
  const rest = rowSrc.slice(start + 1);
  const nextGuard = rest.search(/\{tab === '/);
  return nextGuard === -1 ? rest : rest.slice(0, nextGuard);
}

/** Every `members.section_*` heading the card renders, in source order. */
function renderedSections(): string[] {
  return [...rowSrc.matchAll(/<Section label=\{t\('members\.(section_[a-z_]+)'\)\}/g)].map((m) => m[1]);
}

describe('Member card tabs: the declaration (#961)', () => {
  it('is the tabs the tickets name, in its order', () => {
    expect(MEMBER_TABS.map((tab) => tab.id)).toEqual([
      'profile', 'products_services', 'professional_services', 'nutrition', 'personal_goals', 'training_plan',
    ]);
    expect(MEMBER_TAB_IDS).toEqual(MEMBER_TABS.map((tab) => tab.id));
    // Profile is what a Member opens on (§"Navigation behaviour").
    expect(DEFAULT_MEMBER_TAB).toBe('profile');
  });

  it('keeps Profile to who the Member is and sends the rest to Products & Services', () => {
    // §1: Profile is who the Member is — their fields and their login. #1051
    // moved the plans they hold out of it.
    expect(sectionsForTab('profile')).toEqual([
      'section_profile', 'section_account',
    ]);
    // The thread's `Q2` answer: every section the ticket's own table left
    // unassigned goes to Products & Services, in the order the card had them —
    // with Membership Plans first, per #1051.
    expect(sectionsForTab('products_services')).toEqual([
      'section_membership_plans',
      'section_additional_services',
      'section_billing_simulation',
      'section_pt_slots',
      'section_session_packages',
      'section_billing_events',
    ]);
    // #1227: the Member's Professional Service balance is a tab of its own.
    expect(sectionsForTab('professional_services')).toEqual(['section_professional_services']);
    expect(sectionsForTab('nutrition')).toEqual(['section_nutrition_plans']);
    expect(sectionsForTab('personal_goals')).toEqual(['section_personal_goals']);
    expect(sectionsForTab('training_plan')).toEqual(['section_training_plans']);
  });

  it('gives every section exactly one tab', () => {
    const declared = MEMBER_TABS.flatMap((tab) => tab.sections);
    expect(new Set(declared).size, 'a section is declared by two tabs').toBe(declared.length);
    // And the declaration is the card's actual sections — no section was lost
    // in the move, and none is declared that nothing renders.
    expect([...declared].sort()).toEqual([...renderedSections()].sort());
  });

  it('falls back to Profile for a `?tab=` the app does not have', () => {
    for (const id of MEMBER_TAB_IDS) {
      expect(isMemberTabId(id)).toBe(true);
      expect(memberTabFromParam(id)).toBe(id);
    }
    for (const junk of [null, undefined, '', 'billing', 'Profile', 'profile ']) {
      expect(isMemberTabId(junk)).toBe(false);
      expect(memberTabFromParam(junk)).toBe('profile');
    }
    expect(sectionsForTab('nutrition' as any)).toHaveLength(1);
  });

  it('names a label key per tab and nothing a page would have to invent', () => {
    for (const tab of MEMBER_TABS) {
      expect(tab.labelKey, tab.id).toBe(`tab_${tab.id}`);
    }
  });
});

describe('Member card tabs: only the selected tab renders (#961)', () => {
  it('renders each tab\'s sections inside that tab\'s guard, in the declared order', () => {
    for (const tab of MEMBER_TABS) {
      const body = pane(tab.id);
      const positions = tab.sections.map((key) => body.indexOf(`t('members.${key}')`));
      for (const [i, pos] of positions.entries()) {
        expect(pos, `${tab.sections[i]} is not in the ${tab.id} tab`).toBeGreaterThan(-1);
      }
      expect(positions, `${tab.id} renders its sections out of declaration order`)
        .toEqual([...positions].sort((a, b) => a - b));

      // …and no other tab's sections: a section visible on two tabs is the
      // long column coming back.
      const foreign = MEMBER_TABS
        .filter((other) => other.id !== tab.id)
        .flatMap((other) => other.sections)
        .filter((key) => body.includes(`<Section label={t('members.${key}')}`));
      expect(foreign, `${tab.id} also renders ${foreign.join(', ')}`).toEqual([]);
    }
  });

  it('leaves no section outside a tab', () => {
    const outsideAnyTab = rowSrc.slice(0, rowSrc.indexOf("{tab === '"));
    for (const key of renderedSections()) {
      expect(outsideAnyTab, `${key} renders on every tab`).not.toContain(`t('members.${key}')`);
    }
  });

  it('starts each tab without the card\'s hairline above its first section', () => {
    for (const tab of MEMBER_TABS) {
      const first = tab.sections[0] as MemberSectionKey;
      const body = pane(tab.id);
      expect(body, `${tab.id} opens with a divider above ${first}`)
        .toContain(`<Section label={t('members.${first}')} divider={false}>`);
    }
  });

  it('is handed the tab rather than choosing one', () => {
    expect(rowSrc).toContain('tab: MemberTabId');
    expect(rowSrc).toContain("from './memberTabs'");
    // The strip belongs to the page, so the row cannot show a second one.
    expect(rowSrc).not.toContain('<Tabs');
    expect(rowSrc).not.toContain('useState<MemberTabId');
  });
});

describe('Member card tabs: the shared strip (#961)', () => {
  it('is the app\'s one tab component, rendered from MEMBER_TABS', () => {
    expect(pageSrc).toContain('<Tabs');
    expect(pageSrc).toContain('tabs={MEMBER_TABS}');
    expect(pageSrc).toContain("from '@/components/Tabs'");
    // Promoted out of the Nutrition Library's own strip rather than copied:
    // one tab look and one keyboard implementation in the app.
    expect(read(SRC, 'components', 'goalLibrary', 'LibraryTabs.tsx')).toContain("from '@/components/Tabs'");
  });

  it('resolves no label of its own', () => {
    for (const forbidden of ['useTranslations', 'next-intl']) {
      expect(tabsSrc, `Tabs.tsx reaches for ${forbidden}`).not.toContain(forbidden);
    }
    expect(tabsSrc).toContain('label(tab.labelKey)');
  });

  it('declares no colour of its own — every value is a Theme variable', () => {
    for (const literal of [...tabsSrc.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0])) {
      const at = tabsSrc.indexOf(literal);
      const line = tabsSrc.slice(tabsSrc.lastIndexOf('\n', at) + 1, tabsSrc.indexOf('\n', at));
      expect(line, `a hex outside a var() fallback: ${line.trim()}`).toMatch(/var\(--[a-z-]+, #/);
    }
    // The active tab follows the navigation accent, never a hue picked here.
    expect(tabsSrc).toContain("borderBottomColor: 'var(--brand, #4b45c6)'");
    // And the page's own wrapper is spacing only.
    expect(pageSrc).toMatch(/const tabStripWrapStyle: React\.CSSProperties = \{ padding: '[^']+' \};/);
  });

  it('is a tablist a keyboard can drive, and scrolls rather than wraps', () => {
    expect(tabsSrc).toContain('role="tablist"');
    expect(tabsSrc).toContain('role="tab"');
    expect(tabsSrc).toContain('aria-selected={selected}');
    expect(tabsSrc).toContain('tabIndex={selected ? 0 : -1}');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
      expect(tabsSrc, `the strip ignores ${key}`).toContain(`'${key}'`);
    }
    expect(tabsSrc).toContain("overflowX: 'auto'");
    expect(tabsSrc).toContain("flexWrap: 'nowrap'");
  });
});

describe('Member card tabs: navigation state and Edit mode (#961)', () => {
  it('keeps the expanded Member and their tab in the URL', () => {
    expect(pageSrc).toContain("searchParams.get('member')");
    expect(pageSrc).toContain("memberTabFromParam(searchParams.get('tab'))");
    expect(pageSrc).toContain('syncUrl({ member: String(memberId), tab });');
    // Collapsing the row takes both back out, so the URL never names a Member
    // the page is not showing.
    expect(pageSrc).toContain("syncUrl({ member: '', tab: '' });");
    expect(pageSrc).toContain('member?: string; tab?: string;');
  });

  it('keeps one selected tab per expanded Member', () => {
    expect(pageSrc).toContain('useState<Record<number, MemberTabId>>');
    expect(pageSrc).toContain('tab={activeTab}');
    expect(pageSrc).toContain('onChange={(tab) => selectTab(m.id, tab)}');
  });

  it('opens the Profile tab for the inline Edit form, which is the Profile\'s', () => {
    expect(pageSrc).toContain("selectTab(m.id, 'profile');");
    expect(pageSrc).toContain("{activeTab === 'profile' && editingId === m.id && (");
    // Switching tabs discards nothing: the draft is the page's state, which
    // `⋮ → Edit` seeded and only Save or Cancel clears.
    expect(pageSrc).toContain('setEditForm(toMemberEditFormValues(m));');
    expect(pageSrc).not.toContain('cancelEdit();\n    selectTab');
  });
});

describe('Member card tabs: the labels (#961)', () => {
  it('names every tab in all three locales', () => {
    for (const code of LOCALE_CODES) {
      const members = messages(code).members ?? {};
      for (const tab of MEMBER_TABS) {
        expect(members[tab.labelKey], `${code}.json is missing members.${tab.labelKey}`).toBeTruthy();
      }
      // A tab label is a name, not a sentence.
      for (const tab of MEMBER_TABS) {
        expect(String(members[tab.labelKey]).length, `${code} ${tab.labelKey}`).toBeLessThan(32);
      }
    }
  });

  it('leaves the section headings exactly as they were', () => {
    // The ticket is a layout refactor: no section was renamed on the way into
    // its tab, so the tab labels are new keys beside the old headings.
    for (const code of LOCALE_CODES) {
      const members = messages(code).members ?? {};
      for (const key of renderedSections()) {
        expect(members[key], `${code}.json lost members.${key}`).toBeTruthy();
      }
    }
  });
});
