// #628: shared pure validation for a *set* of Promotions selected together.
//
// The existing apply path (`membership-promotions.ts`) only ever validates one
// promotion at a time against what is already applied. Assigning a Plan with
// several Promotions picked at once needs the same rule stated over the whole
// selection, before anything is written — so the admin UI, the assign endpoint
// and any future multi-select caller all agree on what "compatible" means.
//
//   no promotions                      -> valid
//   exactly one non-stackable          -> valid
//   any number of stackable ones       -> valid
//   a non-stackable + any other        -> invalid
//
// Note this is about the selection itself; per-promotion eligibility (active
// lifecycle, date window, plan targeting) is checked by the caller against the
// database, not here.

export interface StackablePromotion {
  id: number;
  stackable: boolean;
}

export type StackingResult =
  | { ok: true }
  | { ok: false; error: string };

/** Validates that the given Promotions may be applied together. */
export function validatePromotionStacking(promotions: StackablePromotion[]): StackingResult {
  const seen = new Set<number>();
  for (const p of promotions) {
    if (seen.has(p.id)) return { ok: false, error: `Promotion ${p.id} is selected more than once` };
    seen.add(p.id);
  }

  if (promotions.length < 2) return { ok: true };

  const nonStackable = promotions.filter((p) => !p.stackable);
  if (nonStackable.length > 0) {
    return {
      ok: false,
      error: 'A non-stackable promotion cannot be combined with another promotion',
    };
  }

  return { ok: true };
}
