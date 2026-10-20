/** #1883 — the read-only origin chip of a Product or Membership Plan snapshot. */
export type ItemOrigin = 'members_app' | 'admin';

/** The locale key under the page's namespace; a missing or unknown value reads Unknown. */
export function itemOriginKey(origin: string | null | undefined): 'origin_members_app' | 'origin_admin' | 'origin_unknown' {
  if (origin === 'members_app') return 'origin_members_app';
  if (origin === 'admin') return 'origin_admin';
  return 'origin_unknown';
}
