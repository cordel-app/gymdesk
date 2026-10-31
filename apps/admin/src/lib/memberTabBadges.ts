/**
 * #2182 — what the Member card's tab badges say. Pure: the API
 * (`GET /members/:id/tab-counts`) decides the counts, this only decides whether
 * and how one is drawn. Zero, absent or unusable means no badge, never `0`.
 */
export const MAX_BADGE_COUNT = 99;

export function tabBadgeText(count: unknown): string | null {
  const n = typeof count === 'number' ? count : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const whole = Math.floor(n);
  return whole > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(whole);
}
