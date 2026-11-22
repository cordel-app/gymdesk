/**
 * #2833: whether a Promotion application is still a **reference only** — applied to a Product
 * Set that is a Draft and not confirmed yet. Such an application has no snapshot (neither the
 * `snapshot` JSON nor grant snapshot rows): every reader resolves it from the live Promotion, and
 * `confirmDraftPromotionSnapshots()` takes its snapshot in the transaction that confirms the Draft.
 *
 * Anything else reads its own snapshot: a confirmed application, and one on a version that is not
 * a Draft (migration 406 confirmed every such application; the set's status is asked as well so a
 * row written without the stamp is never re-read live). The one SQL spelling of the rule, taking
 * the alias of a `product_promotion_snapshots` row (a line-owned Product application, which names
 * its owning set since migration 454).
 */
export function draftReferenceApplicationSql(alias: string): string {
  return `(${alias}.snapshot_confirmed_at IS NULL AND EXISTS (
            SELECT 1 FROM product_sets draft_ps
             WHERE draft_ps.id = ${alias}.product_set_id AND draft_ps.status = 'in_cart'))`;
}

/**
 * #3026 stage 3c-2 — the same rule asked of the plan snapshot's own row (`plan_promotion_snapshots`,
 * alias given): not confirmed yet (`snapshot_confirmed_at`, migration 448) and on a plan snapshot
 * only an In Cart Product Set links. A snapshot a committed set links as well is that set's
 * contract, so its rows are never re-read live. Readers of a Plan application ask this, never the
 * legacy `user_membership_promotions` row.
 */
export function draftReferencePlanPromotionSql(alias: string): string {
  return `(${alias}.snapshot_confirmed_at IS NULL
           AND EXISTS (SELECT 1 FROM product_set_plan_snapshots ref_j
                         JOIN product_sets ref_ps ON ref_ps.id = ref_j.product_set_id
                        WHERE ref_j.plan_snapshot_id = ${alias}.plan_snapshot_id AND ref_ps.status = 'in_cart')
           AND NOT EXISTS (SELECT 1 FROM product_set_plan_snapshots ref_j2
                             JOIN product_sets ref_ps2 ON ref_ps2.id = ref_j2.product_set_id
                            WHERE ref_j2.plan_snapshot_id = ${alias}.plan_snapshot_id AND ref_ps2.status <> 'in_cart'))`;
}
