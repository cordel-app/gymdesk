// #1779 — the member's own Professional Services balance (My Products tab).
//
// The remaining count is `resolveMemberProfessionalServices()`'s, the very
// balance the booking gate and the staff wallet read, so the three cannot
// disagree; nothing here keeps an accounting of its own. `used` is the ledger
// of spends not returned (`professional_service_consumptions`, #1189 stage 3)
// and `total` is remaining + used: every spend, a package's included, writes a
// ledger row, so the identity holds for every source.
// #2605 stage 3: `booked` is the units the member's future bookings hold
// (`reserved` rows) and `available` is remaining - booked, the figure the
// booking sheet offers and the gate refuses on (`loadServiceBalanceViews()`).
import { db } from '../infra/db';
import { attachTranslations } from './professional-service-translations';
import { loadServiceBalanceViews } from './service-reservation';
import { familyWalletOf, inList } from './family-wallet';
import { walletLedgerParams, walletLedgerScope } from '../domain/memberProfessionalServices';

export interface MemberServiceBalance {
  professional_service_id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  total: number;
  used: number;
  remaining: number;
  booked: number;
  available: number;
}

export async function memberServiceBalances(gymId: string, memberId: number, locale: string): Promise<MemberServiceBalance[]> {
  const { rows: base } = await db.query(
    `SELECT ps.id AS professional_service_id, ps.id, ps.name, ps.description, ps.image_url
       FROM professional_services ps
       JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
      WHERE ps.gym_id = ? AND ps.deleted_at IS NULL
      ORDER BY ps.name ASC`,
    [gymId, gymId],
  );
  // #2425: name and description in the request's locale (the member's language,
  // #1039), falling back to the base text — the #2110 translation junction.
  const services = (await attachTranslations(base as any[], locale)).map((s: any) => ({
    ...s, name: s.display_name, description: s.display_description,
  }));
  // #2670 stage 2: the spends of the member's Family wallet, whichever member booked.
  const wallet = await familyWalletOf(db, gymId, memberId);
  const { rows: usedRows } = await db.query(
    `SELECT psc.professional_service_id, COUNT(*) AS n
       FROM professional_service_consumptions psc
      WHERE psc.gym_id = ? AND psc.returned_at IS NULL
        AND ${walletLedgerScope('psc', wallet.familyId, inList(wallet.memberIds))}
      GROUP BY psc.professional_service_id`,
    [gymId, ...walletLedgerParams(wallet.familyId, wallet.memberIds)],
  );
  const used = new Map<number, number>(usedRows.map((r: any) => [Number(r.professional_service_id), Number(r.n)]));
  const views = await loadServiceBalanceViews(gymId, memberId);
  const out: MemberServiceBalance[] = [];
  for (const s of services as Array<{ professional_service_id: number; name: string; description: string | null; image_url: string | null }>) {
    const id = Number(s.professional_service_id);
    const view = views.get(id);
    const remaining = view?.total ?? 0;
    const spent = used.get(id) ?? 0;
    // #1824: the page is the gym's catalogue of active services; a balance of
    // zero is information about a service, never a reason to leave it out.
    out.push({
      professional_service_id: id, name: s.name, description: s.description ?? null, image_url: s.image_url ?? null,
      total: remaining + spent, used: spent, remaining, booked: view?.booked ?? 0, available: view?.available ?? 0,
    });
  }
  return out;
}
