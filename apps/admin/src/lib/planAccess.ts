// #2802 — how the access a Membership Plan grants reads on the Assigned Plan card.
//
// The entries are the server's (`plan_access` on `GET /user-memberships/:id`, decided by
// the plan's own access configuration); this module only picks the locale key and its
// values. Pure: no React, no `t()`, no request.

export interface PlanAccessEntry {
  member_id: number;
  member_name: string | null;
  /** Every physical center; `centers` is then empty. */
  all_centers: boolean;
  centers: { id: number; name: string }[];
  online: boolean;
}

export interface PlanAccessLabel {
  key: 'access_all_centers' | 'access_all_centers_online' | 'access_centers' | 'access_centers_online' | 'access_online';
  values?: { centers: string };
}

/** The `assigned_plans_page` key an entry reads under; `null` when it grants nothing. */
export function planAccessLabel(entry: Pick<PlanAccessEntry, 'all_centers' | 'centers' | 'online'>): PlanAccessLabel | null {
  if (entry.all_centers) return { key: entry.online ? 'access_all_centers_online' : 'access_all_centers' };
  if (entry.centers.length > 0) {
    const centers = entry.centers.map((c) => c.name).join(', ');
    return { key: entry.online ? 'access_centers_online' : 'access_centers', values: { centers } };
  }
  return entry.online ? { key: 'access_online' } : null;
}
