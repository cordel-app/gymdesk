/**
 * #3278 — the application a Purchase was initiated through (`purchases.channel`, migration 472).
 *
 * The one place the accepted values and the routing rule live:
 *   - `members_app`: a request on the Members App's surface, the `/me` routes (the only API the
 *     Members App calls; a superadmin impersonating a member there goes through them too);
 *   - `admin_app`: any other tenant-scoped route (the Admin App's staff routes).
 * The channel is decided from the route the server is answering, never from a request field, and
 * is NULL where no application initiated the Purchase (a system run, a webhook) and on legacy rows.
 * It says which application, not who: the actor's name is `purchases.created_by`.
 */
export const PURCHASE_CHANNELS = ['admin_app', 'members_app'] as const;
export type PurchaseChannel = (typeof PURCHASE_CHANNELS)[number];

/** The channel of a tenant-scoped request on `path` (its URL path, query string ignored). */
export function purchaseChannelForPath(path: string): PurchaseChannel {
  const p = path.split('?')[0];
  return p === '/me' || p.startsWith('/me/') ? 'members_app' : 'admin_app';
}

/** A stored value narrowed to the accepted set; anything else reads as unknown (`null`). */
export function toPurchaseChannel(value: unknown): PurchaseChannel | null {
  return (PURCHASE_CHANNELS as readonly unknown[]).includes(value) ? (value as PurchaseChannel) : null;
}
