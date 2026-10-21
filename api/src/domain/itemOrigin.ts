/**
 * #1883 — the origin of a Product or Membership Plan in a member's ProductSet.
 *
 * Stored as `origin` on the snapshot row of the specific assignment or purchase
 * (migration 302); NULL is "Unknown" and is never guessed. Decided from the
 * action's actual entry point — the Members App routes or the staff routes —
 * never from a role. A clone copies the column verbatim.
 */
export const ITEM_ORIGINS = ['members_app', 'admin'] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

/** The origin of an action: staff (Admin app) or the member (Members App). */
export const originOf = (byStaff: boolean): ItemOrigin => (byStaff ? 'admin' : 'members_app');

/** Narrows a stored value; anything else reads as Unknown (`null`). */
export function toItemOrigin(value: unknown): ItemOrigin | null {
  return (ITEM_ORIGINS as readonly string[]).includes(String(value)) ? (value as ItemOrigin) : null;
}
