// #3504 — what each item of a Membership Plan gives the member access to, for
// the Members App's Add Plan list of included items.
//
// The source of truth is the one #973 books against: the Professional Services
// a Product is linked to (`product_professional_services`). Only services the
// gym can offer are reported (visible to the gym, not deleted, active for it —
// the same predicate `memberProductServiceFilters()` uses), each named in the
// request's locale with the base text as the fallback (#2110). A Product
// linked to none reports an empty list: nothing is inferred from its name.

import { db } from '../infra/db';
import { attachTranslations as attachServiceTranslations } from './professional-service-translations';
import type { MemberPlanOverview } from '../domain/memberPlanOverview';

export interface PlanItemAccess { id: number; name: string }

export async function loadProductAccess(
  gymId: string, productIds: number[], locale: string,
): Promise<Map<number, PlanItemAccess[]>> {
  const out = new Map<number, PlanItemAccess[]>();
  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;
  const { rows } = await db.query<any>(
    `SELECT pps.product_id, ps.id, ps.name, ps.description
       FROM product_professional_services pps
       JOIN products p ON p.id = pps.product_id AND p.gym_id = ?
       JOIN professional_services ps ON ps.id = pps.professional_service_id
       LEFT JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = ?
      WHERE pps.product_id IN (${ids.map(() => '?').join(',')})
        AND (ps.gym_id IS NULL OR ps.gym_id = ?) AND ps.deleted_at IS NULL
        AND COALESCE(gps.status, 'active') = 'active'`,
    [gymId, gymId, ...ids, gymId],
  );
  const services = new Map<number, { id: number; name: string; description: string | null }>();
  for (const r of rows) services.set(Number(r.id), { id: Number(r.id), name: String(r.name), description: r.description ?? null });
  const localized = new Map(
    (await attachServiceTranslations([...services.values()], locale)).map((s) => [s.id, s.display_name as string]),
  );
  for (const r of rows) {
    const list = out.get(Number(r.product_id)) ?? [];
    list.push({ id: Number(r.id), name: localized.get(Number(r.id)) ?? String(r.name) });
    out.set(Number(r.product_id), list);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name, locale));
  return out;
}

/** Fills every overview product's `access` from its Product's linked services. */
export async function attachPlanItemAccess<T extends MemberPlanOverview | null>(
  overview: T, gymId: string, locale: string,
): Promise<T> {
  if (!overview) return overview;
  const access = await loadProductAccess(gymId, overview.products.map((p) => p.product_id), locale);
  for (const p of overview.products) p.access = access.get(p.product_id) ?? [];
  return overview;
}
