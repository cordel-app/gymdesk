// Pure selection logic for the Suitable Membership Plans "Select All"
// checkbox (#554). Kept out of promotions/page.tsx so it can be unit tested
// without any DOM/component harness — see
// apps/admin/src/test/suitable-plans-selection.test.ts.
//
// "Select All" only ever acts on the *displayed* (active) plan ids passed
// in — a promotion's existing association with a plan that has since gone
// inactive is never part of `activeIds`, so it is never touched by these
// helpers, which keeps a prior selection from being silently dropped when
// the admin uses Select All / deselect-all on an unrelated set of plans.

/** True when every displayed (active) plan is currently selected. */
export function isAllSelected(activeIds: number[], selectedIds: number[]): boolean {
  if (activeIds.length === 0) return false;
  const selected = new Set(selectedIds);
  return activeIds.every((id) => selected.has(id));
}

/** True when some, but not all, displayed (active) plans are selected — the checkbox's indeterminate state. */
export function isIndeterminate(activeIds: number[], selectedIds: number[]): boolean {
  const selected = new Set(selectedIds);
  const selectedActiveCount = activeIds.filter((id) => selected.has(id)).length;
  return selectedActiveCount > 0 && selectedActiveCount < activeIds.length;
}

/**
 * Returns the next full selection after toggling "Select All":
 * checked=true adds every active id (keeping any non-active id already
 * selected); checked=false removes only active ids (same reason).
 */
export function toggleSelectAll(selectedIds: number[], activeIds: number[], checked: boolean): number[] {
  if (checked) return Array.from(new Set([...selectedIds, ...activeIds]));
  const activeSet = new Set(activeIds);
  return selectedIds.filter((id) => !activeSet.has(id));
}
