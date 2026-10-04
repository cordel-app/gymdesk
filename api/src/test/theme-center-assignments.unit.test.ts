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

// `centers.id` is an auto-increment integer (migration 043), so these are
// numbers exactly as the route reads them out of MySQL.
const centers: ThemeCenterRow[] = [
  { id: 1, theme_id: THEME },
  { id: 2, theme_id: null },
  { id: 3, theme_id: OTHER },
];

describe('themeCenterAssignmentPlan', () => {
  it('assigns the requested Centers that do not already hold the theme', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, [1, 2]);
    expect(plan.assign).toEqual([2]);
    expect(plan.clear).toEqual([]);
    expect(plan.assigned).toEqual([1, 2]);
  });

  it('resolves an id a client sent as a string against the stored number', () => {
    // The defect this module exists to prevent: a browser that kept the id as a
    // string must not read back "center not found" for its own Centers, and the
    // ids reported are the *stored* ones rather than the submitted spelling.
    const plan = themeCenterAssignmentPlan(centers, THEME, ['2']);
    expect(plan.assign).toEqual([2]);
    expect(plan.clear).toEqual([1]);
    expect(plan.assigned).toEqual([2]);
  });

  it('clears a Center the request left out, back to inheriting the Gym Default', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, []);
    expect(plan.assign).toEqual([]);
    expect(plan.clear).toEqual([1]);
    expect(plan.assigned).toEqual([]);
  });

  it('takes a Center away from another theme when it is requested', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, [3]);
    expect(plan.assign).toEqual([3]);
    expect(plan.clear).toEqual([1]);
    expect(plan.assigned).toEqual([3]);
  });

  it('leaves a Center on another theme alone when it is not requested', () => {
    // The submitted set is *this* theme's assignments, never every Center's:
    // `c` keeps `theme_id = OTHER` in both lists' absence.
    const plan = themeCenterAssignmentPlan(centers, THEME, [1]);
    expect(plan.assign).toEqual([]);
    expect(plan.clear).toEqual([]);
    expect(plan.assigned).toEqual([1]);
    expect(planChangesNothing(plan)).toBe(true);
  });

  it('is idempotent — re-submitting what is stored moves nothing', () => {
    const stored = assignedCenterIds(centers, THEME);
    expect(stored).toEqual([1]);
    expect(planChangesNothing(themeCenterAssignmentPlan(centers, THEME, stored))).toBe(true);
  });

  it('ignores a repeated id rather than assigning it twice', () => {
    const plan = themeCenterAssignmentPlan(centers, THEME, [2, '2']);
    expect(plan.assign).toEqual([2]);
    expect(plan.assigned).toEqual([2]);
  });
});

describe('unknownCenterIds', () => {
  it('names the requested ids that are not Centers of this gym', () => {
    expect(unknownCenterIds(centers, [1, 99])).toEqual([99]);
  });

  it('answers empty for a submitted set the gym owns, in either spelling', () => {
    expect(unknownCenterIds(centers, [1, 2, 3])).toEqual([]);
    expect(unknownCenterIds(centers, ['1', '2', '3'])).toEqual([]);
    expect(unknownCenterIds(centers, [])).toEqual([]);
  });
});
