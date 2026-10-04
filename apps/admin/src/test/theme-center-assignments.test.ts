import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  allCentersChecked,
  assignedCenterIds,
  centerSelectionChanged,
  toggleAllCenters,
  toggleCenter,
  type AssignmentCenter,
} from '@/app/[locale]/themes/centerAssignments';

// #985 — the Assignments section is an inline checkbox list persisted by the
// card's own Save: the `Assign Centers` modal, its search field and its
// Assign/Cancel pair are gone. The list's state lives in one JSX-free module so
// the `All Centers` rule and the dirty state are assertable without component
// test infra (apps/admin has none — docs/architecture.md's TL;DR), and the page
// wiring is pinned by scanning the source, exactly as #912 and #901 do.

const SRC = join(__dirname, '..');
const GYM_THEMES = readFileSync(join(SRC, 'app', '[locale]', 'themes', 'page.tsx'), 'utf-8');

function center(id: string, over: Partial<AssignmentCenter> = {}): AssignmentCenter {
  return { id, name: id.toUpperCase(), is_assigned: false, is_inherited: false, ...over };
}

describe('the draft opens at what is stored', () => {
  it('selects the Centers assigned to this theme and nothing else', () => {
    const centers = [
      center('a', { is_assigned: true }),
      center('b', { is_inherited: true }),
      center('c'),
    ];
    expect(assignedCenterIds(centers)).toEqual(new Set(['a']));
  });

  it('does not tick a Center that merely inherits the theme', () => {
    // An inherited Center has no assignment of its own, so its box is unticked
    // and the list says `Inherited` beside the name — ticking it is what makes
    // the assignment explicit, and the save must not do that by itself.
    const centers = [center('b', { is_inherited: true })];
    expect(assignedCenterIds(centers).has('b')).toBe(false);
  });

  it('is not dirty until a box moves', () => {
    const centers = [center('a', { is_assigned: true }), center('b')];
    const stored = assignedCenterIds(centers);
    expect(centerSelectionChanged(stored, new Set(stored))).toBe(false);
    expect(centerSelectionChanged(stored, toggleCenter(stored, 'b', true))).toBe(true);
    expect(centerSelectionChanged(stored, toggleCenter(stored, 'a', false))).toBe(true);
  });

  it('reports no change while the section is still loading', () => {
    expect(centerSelectionChanged(null, new Set(['a']))).toBe(false);
    expect(centerSelectionChanged(new Set(['a']), null)).toBe(false);
  });
});

describe('All Centers is derived, never its own state (§4)', () => {
  const centers = [center('a'), center('b'), center('c')];

  it('checks itself once every Center is selected by hand', () => {
    let selected = new Set<string>();
    expect(allCentersChecked(centers, selected)).toBe(false);
    for (const c of centers) selected = toggleCenter(selected, c.id, true);
    expect(allCentersChecked(centers, selected)).toBe(true);
  });

  it('clears itself as soon as one Center is unselected', () => {
    const selected = toggleCenter(new Set(['a', 'b', 'c']), 'b', false);
    expect(allCentersChecked(centers, selected)).toBe(false);
  });

  it('selects every Center when ticked and clears the set when unticked', () => {
    expect(toggleAllCenters(centers, true)).toEqual(new Set(['a', 'b', 'c']));
    expect(toggleAllCenters(centers, false)).toEqual(new Set());
  });

  it('reads unchecked for a gym with no Centers', () => {
    // Vacuous truth would tick a box over an empty list; the page renders its
    // `No centers available.` message instead (§7).
    expect(allCentersChecked([], new Set())).toBe(false);
  });
});

describe('the page keeps no second copy of the rule (§1, §5)', () => {
  it('renders no Assign Centers modal, search field or Assign action', () => {
    for (const gone of ['pickerOpen', 'pickerSelected', 'unassigned-centers', 'assign-centers', 'centersSearch', 'showAllCenters']) {
      expect(GYM_THEMES).not.toContain(gone);
    }
  });

  it('persists the set through the one replace-all route, from Save', () => {
    expect(GYM_THEMES).toContain('/centers`, {');
    expect(GYM_THEMES).toContain("method: 'PUT'");
    expect(GYM_THEMES).toContain('center_ids: submitted');
  });

  it('asks the module for the All Centers state rather than deriving it inline', () => {
    expect(GYM_THEMES).toContain('allCentersChecked(centers, selection)');
    expect(GYM_THEMES).toContain('toggleAllCenters(centers, e.target.checked)');
    expect(GYM_THEMES).toContain('toggleCenter(selection, center.id, e.target.checked)');
  });

  it('puts the Centers in the card\'s dirty state', () => {
    expect(GYM_THEMES).toContain('centersDirty()');
    expect(GYM_THEMES).toContain('centerSelectionChanged(centerBaselineRef.current, centerSelection)');
  });
});
