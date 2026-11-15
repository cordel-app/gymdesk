/**
 * #2833: whether a Promotion application is still a **reference only** — applied to a Product
 * Set that is a Draft and not confirmed yet. Such an application has no snapshot (neither the
 * `snapshot` JSON nor grant snapshot rows): every reader resolves it from the live Promotion, and
 * `confirmDraftPromotionSnapshots()` takes its snapshot in the transaction that confirms the Draft.
 *
 * Anything else reads its own snapshot: a confirmed application, and one on a version that is not
 * a Draft (migration 406 confirmed every such application; the set's status is asked as well so a
 * row written without the stamp is never re-read live). The one SQL spelling of the rule, taking
 * the alias of a `user_membership_promotions` row.
 */
export function draftReferenceApplicationSql(alias: string): string {
  return `(${alias}.snapshot_confirmed_at IS NULL AND EXISTS (
            SELECT 1 FROM product_sets draft_ps
             WHERE draft_ps.id = ${alias}.product_set_id AND draft_ps.status = 'draft'))`;
}
