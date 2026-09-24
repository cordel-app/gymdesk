// Where a theme's logo lives (#713). Shared by every router that returns a
// theme-shaped response: `gym-themes.ts`, `gyms.ts` and `me.ts`.

import { buildStorageObjectUrl } from '../infra/storage';

/**
 * #713: public URL of a theme logo stored in a gym's Cloudflare R2 folder, or
 * null when the row has no object key — a Base Theme, a Custom Theme whose logo
 * is still a `logo_bytes` blob (uploaded before migration 180), or a theme with
 * no logo at all. Those are served by `GET /themes/:id/logo`, which every
 * consumer keeps as its fallback.
 *
 * The key is fixed (`Branding/Logo/logo.<ext>`), so replacing a logo reuses the
 * same URL — hence the `?v=` stamp from `logo_updated_at`, the same cache-buster
 * the API logo route has always carried. R2 ignores the extra query parameter.
 */
export function themeLogoUrl(
  row: { logo_object_key?: string | null; logo_updated_at?: Date | string | null },
): string | null {
  const url = buildStorageObjectUrl(row.logo_object_key);
  if (!url) return null;
  const updatedAt = row.logo_updated_at ? new Date(row.logo_updated_at).getTime() : NaN;
  return Number.isNaN(updatedAt) ? url : `${url}?v=${updatedAt}`;
}
