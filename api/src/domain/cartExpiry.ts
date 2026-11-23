/**
 * #3274 — the two-hour In-Cart expiry of a purchase (#3251's cart), and the one place it is decided.
 *
 * A cart is a `purchases` row in `in_cart`; whatever it holds — a Product Set Draft, standalone
 * one-time Products, or both — shares its one clock, `purchases.expires_at` (migration 470):
 *   - two hours ahead when the cart is opened or returns to the cart (#1991),
 *   - two hours ahead again on every successful change of its contents (`refreshCartSql()`, which
 *     never revives a cart already past its time),
 *   - NULL while the purchase is not `in_cart`: a Pending Payment keeps #1991's own timeout and a
 *     completed or cancelled purchase has no cart clock.
 * Reading a cart never moves it. Nothing derives a cart's expiry from a Product Set's
 * `last_activity_at` or a line's `created_at` any more.
 *
 * Pure: SQL fragments over the database's own clock (`UTC_TIMESTAMP()`, so no DATETIME crosses a
 * time zone) and a seconds normaliser; `api/purchases.ts` writes the column and
 * `api/cart-expiry.ts` runs the sweep.
 */

/** How long a cart lives after its last change (#1325's and #2962's two hours, now one number). */
export const CART_TTL_MINUTES = 120;

/** The expiry a cart opened or changed now takes. */
export const CART_EXPIRES_AT_SQL = `UTC_TIMESTAMP() + INTERVAL ${CART_TTL_MINUTES} MINUTE`;

/**
 * The clock of the purchase `pu` (alias). An `in_cart` row written with no clock — by an API image
 * still running the previous code while migration 470 deploys — reads as two hours after its
 * creation, so it neither expires at once nor lives for ever, and its next change gives it a clock.
 */
export const cartClockSql = (pu: string): string =>
  `COALESCE(${pu}.expires_at, ${pu}.created_at + INTERVAL ${CART_TTL_MINUTES} MINUTE)`;

/** Is the purchase `pu` (alias) an In-Cart cart past its time? Any other status is never expired here. */
export const purchaseCartExpiredSql = (pu: string): string =>
  `(${pu}.status = 'in_cart' AND ${cartClockSql(pu)} <= UTC_TIMESTAMP())`;

/**
 * Is the Product Set `ps` (alias or table name) in an expired cart? Only a set in the cart can be;
 * a set no checkout made (`purchase_id` NULL: a bridge or reprice version, activated in its own
 * transaction) has no cart clock.
 */
export const setCartExpiredSql = (ps: string): string =>
  `(${ps}.status = 'in_cart' AND EXISTS (SELECT 1 FROM purchases cx_
     WHERE cx_.id = ${ps}.purchase_id AND ${purchaseCartExpiredSql('cx_')}))`;

/** The live-cart half of `setCartExpiredSql()`: an In-Cart set whose cart is not expired. */
export const setCartLiveSql = (ps: string): string =>
  `(${ps}.status = 'in_cart' AND NOT EXISTS (SELECT 1 FROM purchases cx_
     WHERE cx_.id = ${ps}.purchase_id AND ${purchaseCartExpiredSql('cx_')}))`;

/** The cart expiry of the Product Set `ps`, NULL when it is not in a cart that has one. */
export const setCartExpiresAtSql = (ps: string): string =>
  `(SELECT ${cartClockSql('cx_')} FROM purchases cx_ WHERE cx_.id = ${ps}.purchase_id AND cx_.status = 'in_cart')`;

/** Seconds the Product Set `ps`'s cart has left (NULL with none; may be negative). */
export const setCartExpiresInSecondsSql = (ps: string): string =>
  `(SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), ${cartClockSql('cx_')}) FROM purchases cx_
     WHERE cx_.id = ${ps}.purchase_id AND cx_.status = 'in_cart' AND ${ps}.status = 'in_cart')`;

/** The cart expiry of a one-time line whose purchase column is `col`, NULL when it is not in a cart. */
export const lineCartExpiresAtSql = (col: string): string =>
  `(SELECT ${cartClockSql('cx_')} FROM purchases cx_ WHERE cx_.id = ${col} AND cx_.status = 'in_cart')`;

/**
 * Is the line whose purchase column is `col` outside an expired cart? Only an In-Cart purchase past
 * its time expires its lines; a line whose purchase is mid-checkout (its set's Save & Pay has moved
 * the purchase on in the same transaction) is not expired by this rule.
 */
export const lineCartLiveSql = (col: string): string =>
  `NOT EXISTS (SELECT 1 FROM purchases cx_ WHERE cx_.id = ${col} AND ${purchaseCartExpiredSql('cx_')})`;

/**
 * Seconds a cart has left, from the database's own clock. `null` with no clock; never negative —
 * an expired cart reports 0.
 */
export function cartExpiresInSeconds(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/** An expiry read from the database as an ISO string, or null. */
export function cartExpiresAtIso(raw: unknown): string | null {
  if (raw == null) return null;
  const d = raw instanceof Date ? raw : new Date(String(raw).replace(' ', 'T') + (String(raw).endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
