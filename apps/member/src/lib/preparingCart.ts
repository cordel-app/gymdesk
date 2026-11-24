// #3154 — the *Your gym is preparing a change* card, decided.
//
// A Draft staff are still setting up (#2895) is the member's to read only, so
// its card says one thing — purchasing in the app is paused — and lists what
// the change holds: the Membership Plans by name, then the Products as
// bullets, each with its thumbnail and its applied Promotions. No item price
// is shown anywhere on it or in its modals; the one figure is the Product
// Set's Initial Payment, the server's review (`commitCharge()`). This module
// resolves no `t()`, computes no money and spells no colour: it turns the
// set view into rows and locale keys, and `PreparingCartCard.tsx` draws them.
import { standaloneAwaitsStaff, type CartPromotion, type MemberCartView, type MemberStandaloneCart } from './memberCart';
import type { ProductNote } from './memberProducts';
import { formatGymNumber, type GymFormatSettings } from './gymFormat';

/** One Promotion beside a plan or a Product, with what its modal says. */
export interface PreparingPromotion {
  key: string;
  name: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  description: string | null;
  /** The main terms, as locale keys — never an amount. */
  terms: ProductNote[];
}

/** One plan or Product of the card. */
export interface PreparingItem {
  key: string;
  name: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  description: string | null;
  /** A plan's included services and items (`2 × Personal Training`): names and quantities, no price, no Mandatory/Optional. */
  included: { key: string; name: string; quantity: number }[];
  promotions: PreparingPromotion[];
}

export interface PreparingCartContent {
  plans: PreparingItem[];
  products: PreparingItem[];
}

type ViewPromotionLike = CartPromotion;

const positive = (n: number | null | undefined): n is number => n != null && Number.isFinite(Number(n)) && Number(n) > 0;

/** A plan Promotion's main terms: its Membership Fee Benefit, its duration and its Free / Paid / Bonus months. */
export function planPromotionTerms(p: ViewPromotionLike, gym?: GymFormatSettings): ProductNote[] {
  const terms: ProductNote[] = [];
  const fee = p.membership_fee_benefit;
  if (fee) {
    switch (fee.action) {
      case 'waive': terms.push({ key: 'membership.preparing_term_fee_waive' }); break;
      case 'percentage_discount':
        if (fee.value != null) terms.push({ key: 'membership.preparing_term_fee_percentage', values: { value: formatGymNumber(fee.value, gym, 2) } });
        break;
      case 'fixed_discount': terms.push({ key: 'membership.preparing_term_fee_fixed_discount' }); break;
      case 'fixed_price': terms.push({ key: 'membership.preparing_term_fee_fixed_price' }); break;
      default: break;
    }
    if (terms.length > 0 && positive(fee.duration_months)) {
      terms.push({ key: 'membership.preparing_term_duration_months', values: { count: Number(fee.duration_months) } });
    }
  }
  if (positive(p.free_months)) terms.push({ key: 'membership.preparing_term_free_months', values: { count: Number(p.free_months) } });
  if (positive(p.paid_months)) terms.push({ key: 'membership.preparing_term_paid_months', values: { count: Number(p.paid_months) } });
  if (positive(p.bonus_months)) terms.push({ key: 'membership.preparing_term_bonus_months', values: { count: Number(p.bonus_months) } });
  return terms;
}

/** A Product Promotion's main terms: its treatment and the billing cycles it covers. */
export function productPromotionTerms(p: ViewPromotionLike, gym?: GymFormatSettings): ProductNote[] {
  const terms: ProductNote[] = [];
  switch (p.benefit_action) {
    case 'waive': terms.push({ key: 'membership.preparing_term_product_waive' }); break;
    case 'percentage_discount':
      if (p.benefit_value != null) terms.push({ key: 'membership.preparing_term_product_percentage', values: { value: formatGymNumber(Number(p.benefit_value), gym, 2) } });
      break;
    case 'fixed_discount': terms.push({ key: 'membership.preparing_term_product_fixed_discount' }); break;
    case 'fixed_price': terms.push({ key: 'membership.preparing_term_product_fixed_price' }); break;
    default: break;
  }
  if (positive(p.duration_cycles)) terms.push({ key: 'membership.promotion_duration_cycles', values: { count: Number(p.duration_cycles) } });
  return terms;
}

function promotionOf(owner: string, p: ViewPromotionLike, terms: ProductNote[]): PreparingPromotion {
  const image = p.image_url ?? p.promotion_image_url ?? null;
  return {
    key: `${owner}-promo-${p.id ?? p.promotion_id}`,
    name: p.promotion_name ?? '—',
    thumbnailUrl: p.image_thumbnail_url ?? p.promotion_image_thumbnail_url ?? image,
    imageUrl: image,
    description: p.description ?? null,
    terms,
  };
}

/**
 * What the card lists: the plans the Draft adds and the Products it adds
 * (recurring lines and one-time Products), in the cart's own order.
 */
export function preparingCartContent(
  view: MemberCartView | null,
  gym?: GymFormatSettings,
  standalone?: MemberStandaloneCart | null,
): PreparingCartContent {
  // #3305: the standalone one-time purchases of a cart staff are preparing are its Products too.
  const standaloneProducts: PreparingItem[] = standaloneAwaitsStaff(standalone)
    ? standalone!.purchases.map((p) => ({
      key: `standalone-${p.id}`, name: p.product_name, thumbnailUrl: null, imageUrl: null,
      description: null, included: [], promotions: [],
    }))
    : [];
  if (!view || !view.awaiting_staff_setup) return { plans: [], products: standaloneProducts };
  const plans: PreparingItem[] = (view.plans ?? [])
    .filter((p) => p.change === 'added' && !p.entitlement_only)
    .map((p) => {
      const key = `plan-${p.plan_snapshot_id}`;
      return {
        key,
        name: p.plan_name ?? '—',
        thumbnailUrl: p.plan_image_thumbnail_url ?? p.plan_image_url ?? null,
        imageUrl: p.plan_image_url ?? null,
        description: p.plan_description ?? null,
        included: (p.benefits ?? []).map((b, i) => ({ key: `${key}-b-${b.category}-${b.product_id}-${i}`, name: b.name, quantity: Number(b.quantity) || 1 })),
        promotions: (p.promotions ?? []).map((x) => promotionOf(key, x, planPromotionTerms(x, gym))),
      };
    });
  const lines: PreparingItem[] = (view.lines ?? [])
    .filter((l) => l.change === 'added')
    .map((l) => {
      const key = `line-${l.id}`;
      return {
        key,
        name: l.product_name ?? '—',
        thumbnailUrl: l.image_thumbnail_url ?? l.image_url ?? null,
        imageUrl: l.image_url ?? null,
        description: l.description ?? null,
        included: [],
        promotions: (l.promotions ?? []).map((x) => promotionOf(key, x, productPromotionTerms(x, gym))),
      };
    });
  const purchases: PreparingItem[] = (view.purchases ?? []).map((p) => {
    const key = `purchase-${p.id}`;
    return {
      key,
      name: p.product_name,
      thumbnailUrl: p.image_thumbnail_url ?? p.image_url ?? null,
      imageUrl: p.image_url ?? null,
      description: p.description ?? null,
      included: [],
      promotions: (p.promotions ?? []).map((x) => promotionOf(key, x, productPromotionTerms(x, gym))),
    };
  });
  return { plans, products: [...lines, ...purchases, ...standaloneProducts] };
}
