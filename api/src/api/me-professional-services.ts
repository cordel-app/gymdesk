// #1779 — the member's own Professional Services balance (My Products tab).
//
// The remaining count is `resolveMemberProfessionalServices()`'s, the very
// balance the booking gate and the staff wallet read, so the three cannot
// disagree; nothing here keeps an accounting of its own. `used` is the ledger
// of spends not returned (`professional_service_consumptions`, #1189 stage 3)
// and `total` is remaining + used: every spend, a package's included, writes a
// ledger row, so the identity holds for every source.
import { db } from '../infra/db';
import { resolveMemberProfessionalServices } from '../domain/memberProfessionalServices';

export interface MemberServiceBalance {
  professional_service_id: number;
  name: string;
  description: string | null;
  total: number;
  used: number;
  remaining: number;
}

export async function memberServiceBalances(gymId: string, memberId: number): Promise<MemberServiceBalance[]> {
  const { rows: services } = await db.query(
    `SELECT ps.id AS professional_service_id, ps.name, ps.description
       FROM professional_services ps
       JOIN gym_professional_services gps
         ON gps.professional_service_id = ps.id AND gps.gym_id = ? AND gps.status = 'active'
      WHERE ps.deleted_at IS NULL
      ORDER BY ps.name ASC`,
    [gymId],
  );
  const { rows: usedRows } = await db.query(
    `SELECT professional_service_id, COUNT(*) AS n
       FROM professional_service_consumptions
      WHERE gym_id = ? AND member_id = ? AND returned_at IS NULL
      GROUP BY professional_service_id`,
    [gymId, memberId],
  );
  const used = new Map<number, number>(usedRows.map((r: any) => [Number(r.professional_service_id), Number(r.n)]));
  const balances = new Map(
    (await resolveMemberProfessionalServices(gymId, memberId)).map((b) => [b.professional_service_id, b.sessions]),
  );
  const out: MemberServiceBalance[] = [];
  for (const s of services as Array<{ professional_service_id: number; name: string; description: string | null }>) {
    const id = Number(s.professional_service_id);
    const remaining = Math.max(0, balances.get(id) ?? 0);
    const spent = used.get(id) ?? 0;
    // #1824: the page is the gym's catalogue of active services; a balance of
    // zero is information about a service, never a reason to leave it out.
    out.push({ professional_service_id: id, name: s.name, description: s.description ?? null, total: remaining + spent, used: spent, remaining });
  }
  return out;
}
