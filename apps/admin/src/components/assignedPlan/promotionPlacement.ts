// #2478 / #2657 — the pure helpers the Assigned Plan card's Promotion row uses.
//
// #2478 drew each application under every Product line it granted; #2657 draws
// it once, as a plan-level row below Period Benefits, so nothing is *placed*
// any more. What is left is reading an application's grants and choosing the
// thumbnail. Pure, so it is asserted without rendering.

import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import type { AppliedPromotion, AppliedPromotionGrant } from './types';

export function promotionGrants(p: AppliedPromotion): AppliedPromotionGrant[] {
  return [...(p.oneoff_grants ?? []), ...(p.session_grants ?? []), ...(p.periodical_grants ?? [])];
}

/**
 * The thumbnail a row draws: the 256 px one, else the master. `null` — and so
 * no thumbnail and no reserved space at all — when there is no usable URL.
 */
export function thumbnailSrc(
  thumbnail: string | null | undefined, master: string | null | undefined,
): string | null {
  const src = thumbnail || master || null;
  return src && SAFE_IMAGE_SRC.test(src) ? src : null;
}
