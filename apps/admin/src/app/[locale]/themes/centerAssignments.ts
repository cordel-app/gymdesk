/**
 * #985 — the Assignments section's Center list, as state rather than as JSX.
 *
 * The section is a checkbox list the page's own Save persists (there is no
 * Assign action and no modal any more), so what it holds is a **draft set** of
 * Center ids compared against the set the server reported. Everything the
 * `All Centers` box does is decided here so the page renders it rather than
 * deriving it: an indeterminate-looking header checkbox and a "one box ticked
 * itself" bug are the two ways this goes wrong.
 *
 * A Center's checkbox means its **own** assignment (`centers.theme_id`), never
 * "this theme reaches it": a Center that merely inherits the theme through the
 * Gym Default is reported with `is_inherited` and reads as that tag beside its
 * name, unticked — ticking it is what makes the assignment explicit, and
 * unticking an assigned one restores inheritance (what `Restore Inheritance`
 * did before this ticket).
 */

/**
 * `centers.id` is an auto-increment integer (migration 043), so the wire value
 * is a number. The draft keys on `centerKey()` rather than on the raw value, so
 * the Set holds one spelling whatever the API sent and the ids submitted back
 * resolve against the stored ones (the route compares them the same way).
 */
export type CenterId = string | number;

export function centerKey(id: CenterId): string {
  return String(id);
}

export interface AssignmentCenter {
  id: CenterId;
  name: string;
  /** `centers.theme_id` points at this theme. */
  is_assigned: boolean;
  /** No assignment of its own, and the Gym Default Theme is this one. */
  is_inherited: boolean;
}

/** The draft the section opens with: exactly what is stored. */
export function assignedCenterIds(centers: AssignmentCenter[]): Set<string> {
  return new Set(centers.filter((c) => c.is_assigned).map((c) => centerKey(c.id)));
}

/**
 * `All Centers` is a derived value, never its own piece of state — so selecting
 * every Center by hand checks it, and unticking one clears it, with no third
 * place to keep in step. A gym with no Centers reads unchecked (there is
 * nothing to be assigned to, and the list renders its empty state instead).
 */
export function allCentersChecked(centers: AssignmentCenter[], selected: Set<string>): boolean {
  return centers.length > 0 && centers.every((c) => selected.has(centerKey(c.id)));
}

/** Ticking `All Centers` selects every Center; unticking it clears the set. */
export function toggleAllCenters(centers: AssignmentCenter[], checked: boolean): Set<string> {
  return checked ? new Set(centers.map((c) => centerKey(c.id))) : new Set<string>();
}

export function toggleCenter(selected: Set<string>, centerId: CenterId, checked: boolean): Set<string> {
  const next = new Set(selected);
  const key = centerKey(centerId);
  if (checked) next.add(key); else next.delete(key);
  return next;
}

/**
 * Whether the draft differs from what is stored, which is what puts the
 * Assignments into the card's dirty state: Save is enabled by a ticked box the
 * same way it is by a renamed theme, and the unsaved-changes guard covers both.
 */
export function centerSelectionChanged(baseline: Set<string> | null, selected: Set<string> | null): boolean {
  if (!baseline || !selected) return false;
  if (baseline.size !== selected.size) return true;
  for (const id of selected) if (!baseline.has(id)) return true;
  return false;
}
