/**
 * #2125 M5c-3 — a billing schedule belongs to its **owner**, not to a Product
 * Set chain (`(owner, periodicity)`, Oscar 2026-11-07 / 2026-11-11; migration
 * 396). Every reader that used to find "the chain's schedules" by
 * `root_product_set_id` (dropped in M5d-2) asks for the schedules of the member
 * who owns the given Product Set instead, through this one SQL spelling, so an owner who starts a
 * new chain keeps billing on the schedules they already had.
 *
 * `setIdParam` is the placeholder (or SQL expression) for **any** of the
 * owner's Product Sets. The column is
 * unqualified unless `alias` is given.
 *
 * `opened_by_product_set_id` (M5d-2) says which Product Set *opened* a
 * schedule, and the two writers that may move a schedule a first Product Set
 * anchored (its start date, its cadence) only move one that set opened, so a
 * schedule an earlier Product Set opened is never moved by a later one.
 */
export function scheduleOwnerOfSetSql(setIdParam = '?', alias?: string): string {
  const col = alias ? `${alias}.owner_member_id` : 'owner_member_id';
  return `${col} = (SELECT owner_member_id FROM product_sets WHERE id = ${setIdParam})`;
}
