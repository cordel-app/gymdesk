// Reading the Members image rows of one or more themes (#725).
//
// One place, because three routers return a theme-shaped response and all three
// must agree on what a theme's Members configuration is: `gym-themes.ts` (the
// editor), `me.ts` (`/me/gym` and `/me/gyms`, which is what the Members App
// actually renders from) and any future consumer. The shaping itself is pure
// and lives in `domain/themeMemberImages.ts`; this file only fetches.

import { db } from '../infra/db';
import type { MemberImageRow } from '../domain/themeMemberImages';

/**
 * The Members image rows of the given themes, grouped by `theme_id` — one query
 * for a whole list of themes, which is what #725's "do not make six separate
 * API requests" rules out the alternative of.
 *
 * `gymIds` is always applied (CLAUDE.md: every query filters by `gym_id`), even
 * though `theme_id` already implies the gym: it is the table's own column, so
 * the tenant filter never depends on a join. `themeIds` is optional — omitted,
 * the whole gym's rows come back, which is what the Custom Themes list wants.
 */
export async function loadMemberImagesByTheme(
  gymIds: string[],
  themeIds?: string[],
): Promise<Map<string, MemberImageRow[]>> {
  const byTheme = new Map<string, MemberImageRow[]>();
  const gyms = gymIds.filter((id): id is string => !!id);
  if (gyms.length === 0) return byTheme;
  if (themeIds && themeIds.length === 0) return byTheme;

  const params: any[] = [...gyms];
  let themeClause = '';
  if (themeIds) {
    themeClause = ` AND theme_id IN (${themeIds.map(() => '?').join(',')})`;
    params.push(...themeIds);
  }
  const { rows } = await db.query<MemberImageRow & { theme_id: string }>(
    `SELECT theme_id, slot, object_key, modified_at FROM theme_member_images
     WHERE gym_id IN (${gyms.map(() => '?').join(',')})${themeClause}`,
    params,
  );
  for (const row of rows) {
    const list = byTheme.get(row.theme_id) ?? [];
    list.push(row);
    byTheme.set(row.theme_id, list);
  }
  return byTheme;
}
