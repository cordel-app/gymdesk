import { describe, expect, it } from 'vitest';
import {
  assignedCenterIds,
  planChangesNothing,
  themeCenterAssignmentPlan,
  unknownCenterIds,
  type ThemeCenterRow,
} from '../domain/themeCenterAssignments';

// #985 — a Theme's Center assignments became one replace-all set (`PUT
// /system/themes/:id/centers`), replacing the add-only `assign-centers`, the
// picker's `unassigned-centers` read and the per-Center `DELETE`. What moves for
// a submitted set is decided in one pure place; these are its rules.

const THEME = 'theme-1';
const OTHER = 'theme-2';

const centers: ThemeCenterRow[] = [
  { id: 'a', theme_id: THEME },
  { id: 'b', theme_id: null },
  { id: 'c', theme_id: OTHER },
];

describe('themeCenterAssignmentPlan', () => {
  it('assigns the requested Centers that do not already hold the theme', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, ['a', 'b']);
    expect(plan.assign).toEqual(['b']);
    expect(plan.clear).toEqual([]);
  });

  it('clears a Center the request left out, back to inheriting the Gym Default', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, []);
    expect(plan.assign).toEqual([]);
    expect(plan.clear).toEqual(['a']);
  });

  it('takes a Center away from another theme when it is requested', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, ['c']);
    expect(plan.assign).toEqual(['c']);
    expect(plan.clear).toEqual(['a']);
  });

  it('leaves a Center on another theme alone when it is not requested', () => {
    // The submitted set is *this* theme's assignments, never every Center's:
    // `c` keeps `theme_id = OTHER` in both lists' absence.
    const plan = themeCenterAssignmentPlan(centers, THEME, ['a']);
    expect(plan.assign).toEqual([]);
    expect(plan.clear).toEqual([]);
    expect(planChangesNothing(plan)).toBe(true);
  });

  it('is idempotent — re-submitting what is stored moves nothing', () => {
    const stored = assignedCenterIds(centers, THEME);
    expect(stored).toEqual(['a']);
    expect(planChangesNothing(themeCenterAssignmentPlan(centers, THEME, stored))).toBe(true);
  });

  it('ignores a repeated id rather than assigning it twice', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, ['b', 'b']);
    expect(plan.assign).toEqual(['b']);
  });
});

describe('unknownCenterIds', () => {
  it('names the requested ids that are not Centers of this gym', () => {
    expect(unknownCenterIds(centers, ['a', 'zz'])).toEqual(['zz']);
  });

  it('answers empty for a submitted set the gym owns, including the empty one', () => {
    expect(unknownCenterIds(centers, ['a', 'b', 'c'])).toEqual([]);
    expect(unknownCenterIds(centers, [])).toEqual([]);
  });
});
